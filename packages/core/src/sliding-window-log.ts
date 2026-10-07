import type { RateLimiter, RateLimitResult, SlidingWindowLogConfig } from './types.js';
import { assertPositive } from './validate.js';

/**
 * Sliding window log.
 *
 * Real systems: the "exact" reference algorithm, often a Redis sorted set
 * per key (ZADD timestamp, ZREMRANGEBYSCORE old entries, ZCARD).
 *
 * Core idea: remember the timestamp of every allowed request. To decide,
 * drop timestamps older than `windowMs` and count what's left. The window
 * moves with every request instead of jumping at fixed boundaries.
 *
 * Tradeoff: exactly correct (never more than `limit` in any window of
 * `windowMs`, and no boundary burst), but memory is O(limit) per key
 * instead of O(1). At 1,000 req/min x 1M keys that's a billion timestamps.
 * That cost is why the sliding window counter exists. In this project the
 * log is the ground truth that the counter's accuracy is measured against.
 */
export class SlidingWindowLogLimiter implements RateLimiter {
  private limit: number;
  private windowMs: number;
  /** Per key: timestamps of allowed requests, oldest first. */
  private logs = new Map<string, number[]>();

  constructor(config: SlidingWindowLogConfig) {
    assertPositive('limit', config.limit);
    assertPositive('windowMs', config.windowMs);
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  consume(key: string, now: number = Date.now()): RateLimitResult {
    let log = this.logs.get(key);
    if (log === undefined) {
      log = [];
      this.logs.set(key, log);
    }

    // Evict everything that has slid out of the window (now - windowMs, now].
    const cutoff = now - this.windowMs;
    let expired = 0;
    while (expired < log.length && log[expired]! <= cutoff) expired++;
    if (expired > 0) log.splice(0, expired);

    if (log.length < this.limit) {
      log.push(now);
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - log.length,
        // Fully fresh once the newest entry (this one) leaves the window.
        resetMs: this.windowMs,
      };
    }

    // Full. A slot frees up when the oldest timestamp slides out.
    const oldest = log[0]!;
    const newest = log[log.length - 1]!;
    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetMs: newest + this.windowMs - now,
      retryAfterMs: oldest + this.windowMs - now,
    };
  }
}
