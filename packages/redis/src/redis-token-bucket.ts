import type { Redis } from 'ioredis';
import { resolveCost, type AsyncRateLimiter, type ConsumeOptions, type RateLimitResult } from '@fluxgate/core';
import type { RedisLimiterConfig } from './naive-token-bucket.js';
import { denial, takeTokens } from './token-bucket-script.js';

/**
 * ✅ The fix: an atomic, distributed token bucket.
 *
 * Exactly the same algorithm as the naive version, but the whole
 * read → refill → decide → write runs inside Redis as one Lua script
 * (lua/token-bucket.lua). Redis is single-threaded and runs a script to
 * completion before serving any other command, so no two requests can ever
 * see the same "before" state. One round trip per request.
 *
 * Every app instance pointing at the same Redis shares one global limit.
 */
export class RedisTokenBucket implements AsyncRateLimiter {
  /** Redis round trips made so far (for the benchmarks). */
  calls = 0;
  private prefix: string;

  constructor(
    private redis: Redis,
    private config: RedisLimiterConfig,
  ) {
    this.prefix = config.prefix ?? 'fluxgate:tb:';
  }

  async consume(key: string, options: ConsumeOptions = {}): Promise<RateLimitResult> {
    const cost = resolveCost(options.cost);
    this.calls++;
    // want = need = cost: all of it or nothing, like core's token bucket.
    const r = await takeTokens(this.redis, this.prefix + key, this.config, { want: cost, need: cost });
    if (r.granted === 0) return denial(this.config.capacity, cost, r);
    return { allowed: true, limit: this.config.capacity, remaining: r.remaining, resetMs: r.resetMs };
  }
}
