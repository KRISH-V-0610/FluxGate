import type { Redis } from 'ioredis';
import type { AsyncRateLimiter, RateLimitResult } from '@fluxgate/core';
import type { RedisLimiterConfig } from './naive-token-bucket.js';
import { takeTokens, type TakeResult } from './token-bucket-script.js';

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
 * instead. Throughput and tail
 * latency improve in exchange for a little precision, which is the classic
 * distributed-systems tradeoff of coordination vs accuracy.
 */
export class LeasedTokenBucket implements AsyncRateLimiter {
  /** Redis round trips made so far (for the benchmarks). */
  calls = 0;
  private prefix: string;
  private leases = new Map<string, Lease>();
  /**
   * Negative cache: after Redis says "empty, retry in X ms", deny locally
   * until then. Safe: the shared bucket cannot refill sooner than that.
   */
  private deniedUntil = new Map<string, { until: number; resetAt: number }>();
  /** In-flight lease requests, so 100 concurrent requests trigger 1 Redis call, not 100. */
  private inflight = new Map<string, Promise<TakeResult>>();

  constructor(
    private redis: Redis,
    private config: LeasedLimiterConfig,
  ) {
    this.prefix = config.prefix ?? 'fluxgate:tb:';
  }

  async consume(key: string): Promise<RateLimitResult> {
    for (;;) {
      // Fast path: serve from the local lease, with no network at all.
      const lease = this.leases.get(key);
      if (lease !== undefined && lease.tokens >= 1 && Date.now() < lease.expiresAt) {
        lease.tokens--;
        return {
          allowed: true,
          limit: this.config.capacity,
          remaining: lease.globalRemaining + lease.tokens,
          resetMs: Math.max(0, lease.resetAt - Date.now()),
        };
      }

      const denied = this.deniedUntil.get(key);
      if (denied !== undefined) {
        const now = Date.now();
        if (now < denied.until) {
          return {
            allowed: false,
            limit: this.config.capacity,
            remaining: 0,
            resetMs: Math.max(0, denied.resetAt - now),
            retryAfterMs: denied.until - now,
          };
        }
        this.deniedUntil.delete(key);
      }

      // Slow path: borrow a new batch. If one is already being fetched for
      // this key, wait for it instead of sending a duplicate request.
      let pending = this.inflight.get(key);
      if (pending === undefined) {
        pending = this.borrow(key).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      const taken = await pending;

      if (taken.granted === 0) {
        return {
          allowed: false,
          limit: this.config.capacity,
          remaining: 0,
          resetMs: taken.resetMs,
          retryAfterMs: taken.retryAfterMs,
        };
      }
      // Tokens arrived. Loop and take one. Concurrent waiters may drain the
      // batch first, in which case we borrow again (or get denied).
    }
  }

  private async borrow(key: string): Promise<TakeResult> {
    this.calls++;
    const taken = await takeTokens(this.redis, this.prefix + key, this.config, this.config.leaseSize);
    if (taken.granted === 0) {
      this.deniedUntil.set(key, { until: Date.now() + taken.retryAfterMs, resetAt: Date.now() + taken.resetMs });
    } else {
      this.leases.set(key, {
        tokens: taken.granted,
        expiresAt: Date.now() + this.config.leaseTtlMs,
        globalRemaining: taken.remaining,
        resetAt: Date.now() + taken.resetMs,
      });
    }
    return taken;
  }
}
