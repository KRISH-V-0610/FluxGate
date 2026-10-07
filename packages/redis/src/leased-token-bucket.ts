import type { Redis } from 'ioredis';
import { resolveCost, type AsyncRateLimiter, type ConsumeOptions, type RateLimitResult } from '@fluxgate/core';
import type { RedisLimiterConfig } from './naive-token-bucket.js';
import { denial, takeTokens, type TakeResult } from './token-bucket-script.js';

export interface LeasedLimiterConfig extends RedisLimiterConfig {
  /** How many tokens to borrow from Redis at once. 1 = no leasing. */
  leaseSize: number;
  /** Unused leased tokens are thrown away after this long. */
  leaseTtlMs: number;
}

interface Lease {
  tokens: number;
  expiresAt: number;
  /** Global remaining as of when the lease was taken (stale; for headers only). */
  globalRemaining: number;
  /** When the shared bucket would be full again, as of the lease (for headers only). */
  resetAt: number;
}

/** A borrow's answer, plus how many tokens it needed (so waiters with other costs can judge it). */
interface Borrowed extends TakeResult {
  need: number;
}

/** Sweep expired leases and denials every this many borrows, so idle keys don't pile up in memory. */
const SWEEP_EVERY = 1024;

/**
 * 🧪 Extension: token leasing (local batches from a global bucket).
 *
 * Problem: the atomic limiter costs one Redis round trip per request. At
 * high request rates Redis becomes the bottleneck and every request pays
 * the network latency.
 *
 * Idea: an instance borrows `leaseSize` tokens from the shared bucket in
 * one atomic call, then serves the next requests from that local lease in
 * memory with no network. It's the same idea as a bank teller drawing cash
 * from the vault in bundles instead of walking to the vault per customer.
 *
 * What it costs (measured in bench/leasing.ts):
 *  - FALSE DENIALS: tokens sitting in instance A's lease are invisible to
 *    instance B. B can be denied while A holds unused tokens.
 *  - BOUNDED OVER-ADMISSION: tokens taken earlier can be spent later, after
 *    the shared bucket has refilled. Over any period the extra is at most
 *    (instances × leaseSize). `leaseTtlMs` limits how long that can happen.
 *  - LOST TOKENS: an expired lease's leftovers are discarded, never returned.
 *
 * Under the limit, Redis calls drop to roughly 1/leaseSize per request. At
 * saturation the bucket refills one token at a time, so batches can't form;
 * there, a short local "denied until retry-after" cache saves the calls
 * instead. Throughput and tail latency improve in exchange for a little
 * precision, which is the classic distributed-systems tradeoff of
 * coordination vs accuracy.
 *
 * Weighted costs: a request is served locally only if the lease holds its
 * whole cost. Otherwise the instance borrows max(leaseSize, cost) tokens,
 * accepting no fewer than the cost, and the new batch replaces the old one
 * (its leftovers are given up, as with an expired lease). So size leases in
 * units, a few times the typical cost.
 */
export class LeasedTokenBucket implements AsyncRateLimiter {
  /** Redis round trips made so far (for the benchmarks). */
  calls = 0;
  private prefix: string;
  private leases = new Map<string, Lease>();
  /**
   * Negative cache: Redis said the bucket would hold `need` tokens at
   * `until`, so deny locally until then. Safe: the shared bucket cannot
   * refill faster than its rate (other instances only make it slower).
   */
  private deniedUntil = new Map<string, { until: number; resetAt: number; need: number }>();
  /** In-flight lease requests, so 100 concurrent requests trigger 1 Redis call, not 100. */
  private inflight = new Map<string, Promise<Borrowed>>();
  private borrows = 0;

  constructor(
    private redis: Redis,
    private config: LeasedLimiterConfig,
  ) {
    this.prefix = config.prefix ?? 'fluxgate:tb:';
  }

  async consume(key: string, options: ConsumeOptions = {}): Promise<RateLimitResult> {
    const cost = resolveCost(options.cost);
    for (;;) {
      // Fast path: serve from the local lease, with no network at all.
      const now = Date.now();
      const lease = this.leases.get(key);
      if (lease !== undefined && lease.tokens >= cost && now < lease.expiresAt) {
        lease.tokens -= cost;
        return {
          allowed: true,
          limit: this.config.capacity,
          remaining: lease.globalRemaining + lease.tokens,
          resetMs: Math.max(0, lease.resetAt - now),
        };
      }

      // The cached denial was for `need` tokens. At the refill rate the bucket
      // holds our `cost` that much earlier (smaller cost) or later (bigger).
      const denied = this.deniedUntil.get(key);
      if (denied !== undefined) {
        const until = denied.until + ((cost - denied.need) * 1000) / this.config.refillPerSecond;
        if (now < until) {
          return denial(this.config.capacity, cost, {
            remaining: 0,
            resetMs: Math.max(0, denied.resetAt - now),
            retryAfterMs: Math.ceil(until - now),
          });
        }
      }

      // Slow path: borrow a new batch. If one is already being fetched for
      // this key, wait for it instead of sending a duplicate request.
      let pending = this.inflight.get(key);
      if (pending === undefined) {
        pending = this.borrow(key, cost).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      const taken = await pending;

      // The bucket didn't even have what that borrow needed; we need at least as much.
      if (taken.granted === 0 && cost >= taken.need) return denial(this.config.capacity, cost, taken);
      // Otherwise loop: tokens arrived (take ours, unless concurrent waiters
      // drained them first), or a bigger request was denied and ours may still fit.
    }
  }

  private async borrow(key: string, cost: number): Promise<Borrowed> {
    this.calls++;
    const taken = await takeTokens(this.redis, this.prefix + key, this.config, {
      want: Math.max(this.config.leaseSize, cost),
      need: cost,
    });
    const now = Date.now();
    if (taken.granted === 0) {
      this.deniedUntil.set(key, { until: now + taken.retryAfterMs, resetAt: now + taken.resetMs, need: cost });
    } else {
      this.deniedUntil.delete(key);
      this.leases.set(key, {
        tokens: taken.granted,
        expiresAt: now + this.config.leaseTtlMs,
        globalRemaining: taken.remaining,
        resetAt: now + taken.resetMs,
      });
    }
    if (++this.borrows % SWEEP_EVERY === 0) this.sweep(now);
    return { ...taken, need: cost };
  }

  /** Forget expired leases and denials. Without this, every key ever seen would stay in memory. */
  private sweep(now: number): void {
    for (const [key, lease] of this.leases) if (now >= lease.expiresAt) this.leases.delete(key);
    for (const [key, denied] of this.deniedUntil) if (now >= denied.until) this.deniedUntil.delete(key);
  }
}
