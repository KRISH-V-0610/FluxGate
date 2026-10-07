import type { RateLimiter, RateLimitResult, SlidingWindowCounterConfig } from './types.js';
import { assertPositive } from './validate.js';

/**
 * Sliding window counter (Cloudflare's approximation).
 *
 * Real systems: Cloudflare's rate limiting, described in "How we built rate
 * limiting capable of scaling to millions of domains"
 * (blog.cloudflare.com/counting-things-a-lot-of-different-things).
 *
 * Core idea: keep only two counters per key, one for the previous fixed
 * window and one for the current window, then estimate how many requests fall in
 * the sliding window that ends now:
 *
 *     estimate = previous * (windowMs - elapsed) / windowMs + current
 *
 * where `elapsed` is how far we are into the current window. Halfway
 * through, half of the previous window still "overlaps", so it counts half.
 *
 * Tradeoff: O(1) memory like the fixed window, but no sharp boundary burst.
 * The price is accuracy. The formula assumes the previous window's requests
 * were spread evenly. If they were bunched at the start or end, the estimate
 * is wrong in either direction (shown in the tests and measured in the
 * accuracy benchmark). Cloudflare measured 0.003% wrong decisions on real
 * traffic, which is fine for them because real traffic is rarely adversarial.
 */
export class SlidingWindowCounterLimiter implements RateLimiter {
  private limit: number;
  private windowMs: number;
  private state = new Map<string, { windowIndex: number; previous: number; current: number }>();

  constructor(config: SlidingWindowCounterConfig) {
    assertPositive('limit', config.limit);
    assertPositive('windowMs', config.windowMs);
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  consume(key: string, now: number = Date.now()): RateLimitResult {
    const windowIndex = Math.floor(now / this.windowMs);
    const entry = this.roll(key, windowIndex);

    const elapsed = now - windowIndex * this.windowMs;
    const weight = (this.windowMs - elapsed) / this.windowMs;
    const estimate = entry.previous * weight + entry.current;

    // Ends of the current and the next window (when `current` stops counting at all).
    const windowEnd = (windowIndex + 1) * this.windowMs;
    const resetMs = windowEnd + this.windowMs - now;

    // Cloudflare's rule: allow while the estimated rate is below the limit.
    if (estimate < this.limit) {
      entry.current++;
      const after = estimate + 1;
      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, Math.ceil(this.limit - after)),
        resetMs,
      };
    }

    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetMs,
      retryAfterMs: this.retryAfter(entry.previous, entry.current, elapsed, windowEnd - now),
    };
  }

  /** Move the key's counters forward if time has moved into a new window. */
  private roll(key: string, windowIndex: number) {
    let entry = this.state.get(key);
    if (entry === undefined) {
      entry = { windowIndex, previous: 0, current: 0 };
      this.state.set(key, entry);
    } else if (entry.windowIndex !== windowIndex) {
      // One window later: current becomes previous. More than one: both are stale.
      entry.previous = windowIndex === entry.windowIndex + 1 ? entry.current : 0;
      entry.current = 0;
      entry.windowIndex = windowIndex;
    }
    return entry;
  }

  /**
   * Solve the estimate formula for the earliest time it drops below the limit.
   * Within this window only `previous`'s weight shrinks; if `current` alone
   * already fills the limit, we must wait for the next window where `current`
   * becomes the decaying `previous`.
   */
  private retryAfter(previous: number, current: number, elapsed: number, untilWindowEnd: number): number {
    const W = this.windowMs;
    if (current < this.limit && previous > 0) {
      // previous * (W - e) / W + current < limit  =>  e > W * (1 - (limit - current) / previous)
      const neededElapsed = W * (1 - (this.limit - current) / previous);
      return Math.max(1, Math.floor(neededElapsed - elapsed) + 1);
    }
    // Next window: current * (W - e) / W < limit  =>  e > W * (1 - limit / current)
    const neededElapsed = Math.max(0, W * (1 - this.limit / current));
    return untilWindowEnd + Math.floor(neededElapsed) + 1;
  }
}
