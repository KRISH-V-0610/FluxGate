import type { Redis } from 'ioredis';
import type { TokenBucketConfig } from '@fluxgate/core';
import { LuaScript } from './lua-script.js';

const script = LuaScript.fromFile('token-bucket.lua');

export interface TakeResult {
  /** Tokens actually taken: 0..want. */
  granted: number;
  /** Whole tokens left in the shared bucket afterwards. */
  remaining: number;
  resetMs: number;
  /** Only meaningful when granted === 0. */
  retryAfterMs: number;
}

/**
 * One atomic round trip: take up to `want` tokens from the shared bucket.
 * `now` is for tests only. In production Redis uses its own clock.
 */
export async function takeTokens(
  redis: Redis,
  redisKey: string,
  config: TokenBucketConfig,
  want: number,
  now?: number,
): Promise<TakeResult> {
  const reply = (await script.run(redis, [redisKey], [
    config.capacity,
    config.refillPerSecond,
    want,
    now ?? '',
  ])) as [number, number, number, number];

  const [granted, remaining, resetMs, retryAfterMs] = reply;
  return { granted, remaining, resetMs, retryAfterMs };
}
