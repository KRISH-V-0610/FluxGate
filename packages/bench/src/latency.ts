/**
 * Experiment 3: what does a limiter decision cost?
 *
 * Measures the latency of one consume() call for each store, with 1 request
 * in flight (pure round-trip cost) and with 64 in flight (under load), plus
 * the throughput achieved. One hot key, with a limit high enough that
 * everything is allowed. We're timing the mechanism, not the policy.
 *
 * Requires Redis: docker compose up -d redis
 */
import { randomUUID } from 'node:crypto';
import { TokenBucketLimiter, type AnyRateLimiter } from '@flux-gate/core';
import { connectRedis, LeasedTokenBucket, NaiveRedisTokenBucket, RedisTokenBucket } from '@flux-gate/redis';
import { latencySummary, writeResult } from './common.js';

const redis = await connectRedis({ commandTimeoutMs: 5000 });
const config = { capacity: 1e9, refillPerSecond: 1e9 };
const prefix = `bench:latency:${randomUUID()}:`;

const stores: Record<string, () => AnyRateLimiter & { calls?: number }> = {
  'memory (single instance)': () => new TokenBucketLimiter(config),
  'redis-naive (2 round trips)': () => new NaiveRedisTokenBucket(redis, { ...config, prefix: `${prefix}n:` }),
  'redis-lua (1 round trip)': () => new RedisTokenBucket(redis, { ...config, prefix: `${prefix}l:` }),
  'redis-leased (lease 20)': () =>
    new LeasedTokenBucket(redis, { ...config, prefix: `${prefix}x:`, leaseSize: 20, leaseTtlMs: 1000 }),
};

async function measure(limiter: AnyRateLimiter & { calls?: number }, total: number, inFlight: number) {
  const samples: number[] = [];
  let issued = 0;
  const callsBefore = limiter.calls ?? 0;
  const started = performance.now();
  const worker = async () => {
    while (issued < total) {
      issued++;
      const t0 = performance.now();
      await limiter.consume('hot-key');
      samples.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: inFlight }, worker));
  const seconds = (performance.now() - started) / 1000;
  return {
    ...latencySummary(samples),
    throughputPerSec: Math.round(total / seconds),
    redisCallsPerRequest: limiter.calls === undefined ? 0 : Math.round(((limiter.calls - callsBefore) / total) * 1000) / 1000,
  };
}

const rows = [];
for (const [name, make] of Object.entries(stores)) {
  const limiter = make();
  await measure(limiter, 2000, 8); // warm-up: JIT, connection, EVALSHA script cache
  for (const inFlight of [1, 64]) {
    const result = await measure(limiter, inFlight === 1 ? 5000 : 30000, inFlight);
    rows.push({ store: name, inFlight, ...result });
  }
}

console.table(rows);
writeResult('latency', {
  setup: { note: 'consume() latency in ms, measured in-process; Redis 7.4 in Docker Desktop on the same machine' },
  rows,
});

const leftovers = await redis.keys(`${prefix}*`);
if (leftovers.length > 0) await redis.del(...leftovers);
redis.disconnect();
