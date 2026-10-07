import type { GcraConfig, RateLimiter, RateLimitResult } from './types.js';
import { assertPositive } from './validate.js';

/** Floating-point slack, for the same reason as in token-bucket.ts (intervals like 1000/3 ms). */
const EPSILON = 1e-6;

/**
 * GCRA (Generic Cell Rate Algorithm).
 *
 * Real systems: it comes from ATM telecom networks. Today it powers
 * redis-cell (the CL.THROTTLE command), Shopify's and Heroku's API limits,
 * and the Rust `governor` crate.
 *
 * Core idea: instead of counting tokens, store one timestamp per key, the
 * TAT ("theoretical arrival time"). At the configured rate, requests are
 * "scheduled" one `interval` apart (interval = 1000 / ratePerSecond ms). The
 * TAT is when the schedule would be caught up. A request is allowed if
 * taking it would not push the schedule more than `burst` intervals into
 * the future:
 *
 *     newTat = max(TAT, now) + interval
 *     allow if newTat - now <= burst * interval
 *
 * Tradeoff: it makes exactly the same decisions as a token bucket with
 * capacity = burst and refill = rate (the tests check this on random
 * traffic). It stores one number instead of two and needs no refill
 * arithmetic. That's why it's popular inside Redis, where every byte and
 * every op per key is multiplied by millions of keys. It is less intuitive
 * to read.
 */
export class GcraLimiter implements RateLimiter {
  private burst: number;
  private interval: number;
  /** Per key: the theoretical arrival time (ms). */
  private tats = new Map<string, number>();

  constructor(config: GcraConfig) {
    assertPositive('burst', config.burst);
    assertPositive('ratePerSecond', config.ratePerSecond);
    this.burst = config.burst;
    this.interval = 1000 / config.ratePerSecond;
  }

  consume(key: string, now: number = Date.now()): RateLimitResult {
    const tat = Math.max(this.tats.get(key) ?? now, now);
    const newTat = tat + this.interval;
    const tolerance = this.burst * this.interval;

    // Earliest moment this request would fit: when newTat - now == tolerance.
    const allowAt = newTat - tolerance;

    if (now >= allowAt - EPSILON) {
      this.tats.set(key, newTat);
      return {
        allowed: true,
        limit: this.burst,
        // How many more intervals fit before hitting the tolerance.
        remaining: Math.floor((tolerance - (newTat - now)) / this.interval + EPSILON),
        resetMs: Math.ceil(newTat - now),
      };
    }

    return {
      allowed: false,
      limit: this.burst,
      remaining: 0,
      resetMs: Math.ceil(tat - now),
      retryAfterMs: Math.ceil(allowAt - now),
    };
  }
}
