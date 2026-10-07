/**
 * Experiment 2: reproduce the check-then-act race, then show the fix.
 *
 * Bucket capacity 10 with (practically) no refill, so the correct answer
 * is always exactly 10 admitted. 200 requests for one key are sent by C
 * concurrent workers, each with its own Redis connection, like C app
 * instances or C event-loop requests in flight at once. We sweep C and
 * count how many requests each limiter admits.
 *
 * Requires Redis: docker compose up -d redis
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { connectRedis, NaiveRedisTokenBucket, RedisTokenBucket } from '@fluxgate/redis';
import type { AsyncRateLimiter } from '@fluxgate/core';
import { writeResult } from './common.js';

const CAPACITY = 10;
const REQUESTS = 200;
const TRIALS = 5;
const CONCURRENCY = [1, 2, 5, 10, 25, 50, 100, 200];
const config = { capacity: CAPACITY, refillPerSecond: 0.0001 };

const pool: Redis[] = await Promise.all(
  Array.from({ length: Math.max(...CONCURRENCY) }, () => connectRedis({ commandTimeoutMs: 5000 })),
);

async function trial(make: (redis: Redis) => AsyncRateLimiter, concurrency: number): Promise<number> {
  const key = randomUUID();
  let issued = 0;
  let admitted = 0;
  const worker = async (redis: Redis) => {
    const limiter = make(redis);
    while (issued < REQUESTS) {
      issued++;
      if ((await limiter.consume(key)).allowed) admitted++;
    }
  };
  await Promise.all(pool.slice(0, concurrency).map(worker));
  return admitted;
}

const prefix = `bench:race:${randomUUID()}:`;
const variants = {
  'naive (GET → JS → SET)': (r: Redis) => new NaiveRedisTokenBucket(r, { ...config, prefix: `${prefix}n:` }),
  'atomic (Lua)': (r: Redis) => new RedisTokenBucket(r, { ...config, prefix: `${prefix}l:` }),
};

const rows = [];
for (const concurrency of CONCURRENCY) {
  for (const [name, make] of Object.entries(variants)) {
    const runs: number[] = [];
    for (let i = 0; i < TRIALS; i++) runs.push(await trial(make, concurrency));
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    rows.push({
      concurrency,
      limiter: name,
      admittedMean: Math.round(mean * 10) / 10,
      admittedMax: Math.max(...runs),
      overAdmission: Math.round((mean / CAPACITY) * 100) / 100,
    });
  }
}

console.table(rows);
writeResult('race', { setup: { capacity: CAPACITY, requests: REQUESTS, trials: TRIALS }, rows });

const leftovers = await pool[0]!.keys(`${prefix}*`);
if (leftovers.length > 0) await pool[0]!.del(...leftovers);
pool.forEach((r) => r.disconnect());
