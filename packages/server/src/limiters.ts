import type { Redis } from 'ioredis';
import { TokenBucketLimiter, type AnyRateLimiter, type TokenBucketConfig } from '@flux-gate/core';
import { LeasedTokenBucket, NaiveRedisTokenBucket, RedisTokenBucket } from '@flux-gate/redis';

/**
 * Where the limiter state lives. The same app runs in four modes, which is
 * what makes the before/after comparisons possible:
 *  - memory       each instance counts on its own → 3 instances = 3x the limit
 *  - redis-naive  shared but racy GET/SET          → over-admits under load
 *  - redis-lua    shared and atomic                → correct global limit
 *  - redis-leased shared, atomic, batched          → fewer Redis calls, a little imprecise
 */
export const STORES = ['memory', 'redis-naive', 'redis-lua', 'redis-leased'] as const;
export type Store = (typeof STORES)[number];

export function isStore(value: string): value is Store {
  return (STORES as readonly string[]).includes(value);
}

export interface BuildOptions {
  store: Store;
  config: TokenBucketConfig;
  /** Required for every store except memory. */
  redis?: Redis;
  /** Redis key namespace, e.g. per tier. */
  prefix: string;
  leaseSize?: number;
  leaseTtlMs?: number;
}

export function buildLimiter(o: BuildOptions): AnyRateLimiter {
  if (o.store === 'memory') return new TokenBucketLimiter(o.config);
  if (o.redis === undefined) throw new Error(`store "${o.store}" needs a Redis connection`);

  const config = { ...o.config, prefix: o.prefix };
  switch (o.store) {
    case 'redis-naive':
      return new NaiveRedisTokenBucket(o.redis, config);
    case 'redis-lua':
      return new RedisTokenBucket(o.redis, config);
    case 'redis-leased':
      return new LeasedTokenBucket(o.redis, {
        ...config,
        leaseSize: o.leaseSize ?? 5,
        leaseTtlMs: o.leaseTtlMs ?? 1000,
      });
  }
}

/** Commands this limiter has sent to Redis so far (0 for the in-memory store). */
export function redisCalls(limiter: AnyRateLimiter): number {
  return 'calls' in limiter && typeof limiter.calls === 'number' ? limiter.calls : 0;
}
