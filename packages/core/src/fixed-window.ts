import type { RateLimiter, RateLimitResult, FixedWindowConfig, LocalConsumeOptions } from './types.js';
import { assertPositive, resolveCost } from './validate.js';

/**
 * Fixed window counter.
 *
 * Real systems: the classic "N requests per minute" counter, e.g. a Redis
 * INCR + EXPIRE per minute. Many API gateways start here.
 *
 * Core idea: cut time into slices of `windowMs` (0-999, 1000-1999, ...).
 * Each key gets one counter per slice. When a new slice starts, the counter
 * starts again from zero.
 *
 * Tradeoff: O(1) memory and time per key, but the edges are sharp. A client
 * can use the whole limit at the end of one slice and the whole limit again
 * at the start of the next, so 2x the limit gets through in a few
 * milliseconds (the "boundary burst", demonstrated in the tests).
 */
export class FixedWindowLimiter implements RateLimiter {
  private limit: number;
  private windowMs: number;
  private state = new Map<string, { windowIndex: number; count: number }>();

  constructor(config: FixedWindowConfig) {
    assertPositive('limit', config.limit);
    assertPositive('windowMs', config.windowMs);
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  consume(key: string, options: LocalConsumeOptions = {}): RateLimitResult {
    const now = options.now ?? Date.now();
    const cost = resolveCost(options.cost);

    // 1. Which slice of time does `now` fall into?
    const windowIndex = Math.floor(now / this.windowMs);

    // 2-3. Look up the key; start from zero if it's new or the slice moved on.
    let entry = this.state.get(key);
    if (entry === undefined || entry.windowIndex !== windowIndex) {
      entry = { windowIndex, count: 0 };
      this.state.set(key, entry);
    }

    // 4-5. Admit the request only if its whole cost fits in what's left of
    // this slice. Only admitted requests count, so one oversized request
    // can't use up the slice for everyone after it.
    const allowed = entry.count + cost <= this.limit;
    if (allowed) entry.count += cost;

    // 6. Time left until this slice ends and the counter starts again.
    const resetMs = (windowIndex + 1) * this.windowMs - now;

    // 7. Report back. A denied client can retry exactly when the slice ends,
    // unless the cost is bigger than a whole slice (then it never fits).
    return {
      allowed,
      limit: this.limit,
      remaining: this.limit - entry.count,
      resetMs,
      ...(allowed || cost > this.limit ? {} : { retryAfterMs: resetMs }),
    };
  }
}
