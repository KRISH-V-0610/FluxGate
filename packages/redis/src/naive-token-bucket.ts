import type { Redis } from 'ioredis';
import { resolveCost, tokenBucketStep } from '@fluxgate/core';
import type { AsyncRateLimiter, ConsumeOptions, RateLimitResult, TokenBucketConfig, TokenBucketState } from '@fluxgate/core';

export interface RedisLimiterConfig extends TokenBucketConfig {
  /** Namespace for this limiter's keys, so tiers/limiters never share a bucket. */
  prefix?: string;
}

/**
 * ⚠️ DELIBERATELY BROKEN: the naive way to move a limiter into Redis.
 *
 * It's here because the first version of a distributed limiter almost always
 * looks like this, and it's the "before" in the before/after experiment.
 *
 * Each request does:
 *   1. READ   the bucket from Redis          (HMGET)
 *   2. DECIDE in JavaScript                  (same math as the in-memory one)
 *   3. WRITE  the new bucket back            (HSET + PEXPIRE in a MULTI)
 *
 * The bug is the gap between 1 and 3. Two requests (from the same or
 * different app instances) can both READ "1 token left" before either
 * WRITEs. Both are allowed and both write "0". Two tokens were spent but
 * only one was counted. Under load, many requests read the same stale
 * state, and the limit is exceeded by a large factor (measured in
 * bench/race.ts).
 *
 * Note that MULTI around the write does NOT fix this. MULTI makes the
 * *write* atomic, but the race is between the read and the write. The fix
 * is to move the whole read-decide-write into Redis (see RedisTokenBucket).
 */
export class NaiveRedisTokenBucket implements AsyncRateLimiter {
  /** Redis round trips made so far (for the benchmarks). */
  calls = 0;
  private prefix: string;

  constructor(
    private redis: Redis,
    private config: RedisLimiterConfig,
  ) {
    this.prefix = config.prefix ?? 'fluxgate:naive:';
  }

  async consume(key: string, options: ConsumeOptions = {}): Promise<RateLimitResult> {
    const cost = resolveCost(options.cost);
    const redisKey = this.prefix + key;
    const now = Date.now();

    // 1. READ
    this.calls++;
    const [tokens, lastRefill] = await this.redis.hmget(redisKey, 'tokens', 'ts');
    const state: TokenBucketState | undefined =
      tokens != null && lastRefill != null
        ? { tokens: Number(tokens), lastRefill: Number(lastRefill) }
        : undefined;

    // 2. DECIDE. Meanwhile other requests are reading the same old state.
    const next = tokenBucketStep(state, this.config, now, cost);

    // 3. WRITE
    this.calls++;
    await this.redis
      .multi()
      .hset(redisKey, 'tokens', next.state.tokens, 'ts', next.state.lastRefill)
      .pexpire(redisKey, Math.max(1, next.result.resetMs))
      .exec();

    return next.result;
  }
}
