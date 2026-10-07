import type { Redis } from 'ioredis';
import type { RateLimitResult, TokenBucketConfig } from '@fluxgate/core';
import { LuaScript } from './lua-script.js';

const script = LuaScript.fromFile('token-bucket.lua');

export interface TakeRequest {
  /** The most tokens to take. */
  want: number;
  /** Take nothing unless at least this many are available. Default 1. */
  need?: number;
  /** For tests only. In production Redis uses its own clock. */
  now?: number;
}

export interface TakeResult {
  /** Tokens actually taken: 0, or need..want. */
  granted: number;
  /** Whole tokens left in the shared bucket afterwards. */
  remaining: number;
  resetMs: number;
  /** Only meaningful when granted === 0: when `need` tokens will be there. */
  retryAfterMs: number;
}

/** One atomic round trip: take between `need` and `want` tokens from the shared bucket, or none. */
export async function takeTokens(
  redis: Redis,
  redisKey: string,
  config: TokenBucketConfig,
  request: TakeRequest,
): Promise<TakeResult> {
  const reply = (await script.run(redis, [redisKey], [
    config.capacity,
    config.refillPerSecond,
    request.want,
    request.now ?? '',
    request.need ?? 1,
  ])) as [number, number, number, number];

  const [granted, remaining, resetMs, retryAfterMs] = reply;
  return { granted, remaining, resetMs, retryAfterMs };
}

/**
 * A denial in the shared result shape. When the cost is above capacity no
 * amount of waiting helps, so there is no retryAfterMs (same rule as core).
 */
export function denial(capacity: number, cost: number, taken: Omit<TakeResult, 'granted'>): RateLimitResult {
  return {
    allowed: false,
    limit: capacity,
    remaining: taken.remaining,
    resetMs: taken.resetMs,
    ...(cost > capacity ? {} : { retryAfterMs: taken.retryAfterMs }),
  };
}
