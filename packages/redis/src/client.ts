import { Redis } from 'ioredis';

export interface RedisClientOptions {
  url?: string;
  /** Give up on any single command after this long. Default 250 ms. */
  commandTimeoutMs?: number;
}

/**
 * A Redis client configured for a rate limiter, not for a cache.
 *
 * ioredis's defaults are tuned for "never lose a command". While Redis is
 * down it queues commands and retries each one up to 20 times, so a request
 * can hang for many seconds. For a limiter that's the worst outcome: the
 * request is neither allowed nor denied, it just waits. These settings make
 * failure *fast*, so the middleware's fail-open / fail-closed policy can
 * decide what happens. The failover benchmark measures the difference.
 */
export function createRedisClient(options: RedisClientOptions = {}): Redis {
  return new Redis(options.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    commandTimeout: options.commandTimeoutMs ?? 250,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    // Keep trying to reconnect in the background, backing off to 1 s.
    retryStrategy: (attempt) => Math.min(attempt * 100, 1000),
    lazyConnect: true,
  });
}

/** Connect and wait until the client is ready (the offline queue is off, so we must). */
export async function connectRedis(options: RedisClientOptions = {}): Promise<Redis> {
  const redis = createRedisClient(options);
  // Without a listener, a failed reconnect attempt would surface as an unhandled 'error' event.
  redis.on('error', () => {});
  await redis.connect();
  return redis;
}
