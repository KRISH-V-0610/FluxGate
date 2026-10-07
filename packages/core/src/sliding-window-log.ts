import type { LocalConsumeOptions, RateLimiter, RateLimitResult, SlidingWindowLogConfig } from './types.js';
import { assertPositive, resolveCost } from './validate.js';

/**
 * Sliding window log.
 *
 * Real systems: the "exact" reference algorithm, often a Redis sorted set
 * per key (ZADD timestamp, ZREMRANGEBYSCORE old entries, ZCARD).
 *
 * Core idea: remember the timestamp (and cost) of every allowed request. To
 * decide, drop timestamps older than `windowMs` and add up what's left. The
 * window moves with every request instead of jumping at fixed boundaries.
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
  /**
   * Per key: when each allowed request happened and what it cost, oldest
   * first, plus the running total of the costs still in the window.
   */
  private logs = new Map<string, { times: number[]; costs: number[]; used: number }>();

  constructor(config: SlidingWindowLogConfig) {
    assertPositive('limit', config.limit);
    assertPositive('windowMs', config.windowMs);
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  consume(key: string, options: LocalConsumeOptions = {}): RateLimitResult {
    const now = options.now ?? Date.now();
    const cost = resolveCost(options.cost);
    let log = this.logs.get(key);
    if (log === undefined) {
      log = { times: [], costs: [], used: 0 };
      this.logs.set(key, log);
    }

    // Evict everything that has slid out of the window (now - windowMs, now].
    const cutoff = now - this.windowMs;
    let expired = 0;
    while (expired < log.times.length && log.times[expired]! <= cutoff) {
      log.used -= log.costs[expired]!;
      expired++;
    }
    if (expired > 0) {
      log.times.splice(0, expired);
      log.costs.splice(0, expired);
    }

    if (log.used + cost <= this.limit) {
      log.times.push(now);
      log.costs.push(cost);
      log.used += cost;
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - log.used,
        // Fully fresh once the newest entry (this one) leaves the window.
        resetMs: this.windowMs,
      };
    }

    const newest = log.times[log.times.length - 1];
    const denied = {
      allowed: false,
      limit: this.limit,
      remaining: this.limit - log.used,
      resetMs: newest === undefined ? 0 : newest + this.windowMs - now,
    };
    if (cost > this.limit) return denied; // can never fit, so no retryAfterMs

    // Room frees up as the oldest entries slide out. Find the first moment
    // enough of them are gone for this cost to fit.
    let freed = 0;
    let i = 0;
    while (log.used - freed + cost > this.limit) freed += log.costs[i++]!;
    return { ...denied, retryAfterMs: log.times[i - 1]! + this.windowMs - now };
  }
}
