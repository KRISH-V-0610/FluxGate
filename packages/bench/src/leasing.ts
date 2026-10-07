/**
 * Experiment 4: token leasing, i.e. how much accuracy do we trade for fewer Redis calls?
 *
 * Three simulated app instances share one global bucket (capacity 50,
 * refill 100/s). Each instance receives Poisson traffic, at two load levels:
 *  - under:    25 req/s each,  75 req/s total (below the limit, ideally 0 denials)
 *  - overload: 60 req/s each, 180 req/s total (the limiter must deny ~45%)
 * We sweep the lease size. The baseline is the plain atomic limiter
 * (RedisTokenBucket, one Redis call per request).
 *
 * For every configuration we report:
 *  - admitted vs the baseline (fewer = false denials, tokens stranded in other leases)
 *  - peak admitted in any 1 s vs the hard bound (capacity + rate x 1 s = 150)
 *  - Redis calls per request (the whole point)
 *  - p50 / p99 decision latency
 *
 * Requires Redis: docker compose up -d redis
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AsyncRateLimiter } from '@flux-gate/core';
import { connectRedis, LeasedTokenBucket, RedisTokenBucket } from '@flux-gate/redis';
import { latencySummary, maxInAnyWindow, mulberry32, openLoop, sleep, writeResult } from './common.js';

const INSTANCES = 3;
const LOADS = { under: 25, overload: 60 };
const DURATION_MS = 6000;
const LEASE_SIZES = [1, 2, 5, 10, 20, 50];
const LEASE_TTL_MS = 1000;
const bucket = { capacity: 50, refillPerSecond: 100 };
const BOUND_PER_SECOND = bucket.capacity + bucket.refillPerSecond;

type Load = keyof typeof LOADS;
type Counted = AsyncRateLimiter & { calls: number };

const connections: Redis[] = await Promise.all(
  Array.from({ length: INSTANCES }, () => connectRedis({ commandTimeoutMs: 5000 })),
);

async function run(load: Load, leaseSize: number | null) {
  const ratePerInstance = LOADS[load];
  const prefix = `bench:lease:${randomUUID()}:`;
  const instances: Counted[] = connections.map((redis) =>
    leaseSize === null
      ? new RedisTokenBucket(redis, { ...bucket, prefix })
      : new LeasedTokenBucket(redis, { ...bucket, prefix, leaseSize, leaseTtlMs: LEASE_TTL_MS }),
  );

  const admittedAt: number[] = [];
  const latencies: number[] = [];
  let requests = 0;
  const pending: Promise<void>[] = [];
  const start = performance.now();

  await Promise.all(
    instances.map((limiter, i) =>
      // Same seed for every limiter at a given load, so they all see identical traffic.
      openLoop(ratePerInstance, DURATION_MS, mulberry32(100 * ratePerInstance + i), () => {
        requests++;
        const t0 = performance.now();
        pending.push(
          limiter.consume('tenant').then((r) => {
            const t1 = performance.now();
            latencies.push(t1 - t0);
            if (r.allowed) admittedAt.push(t1 - start);
          }),
        );
      }),
    ),
  );
  await Promise.all(pending);

  const calls = instances.reduce((sum, l) => sum + l.calls, 0);
  admittedAt.sort((a, b) => a - b);
  return {
    load,
    limiter: leaseSize === null ? 'atomic (no lease)' : `lease ${leaseSize}`,
    requests,
    admitted: admittedAt.length,
    deniedPct: Math.round(((requests - admittedAt.length) / requests) * 1000) / 10,
    peakIn1s: maxInAnyWindow(admittedAt, 1000),
    bound1s: BOUND_PER_SECOND,
    redisCallsPerRequest: Math.round((calls / requests) * 1000) / 1000,
    ...latencySummary(latencies),
  };
}

const rows = [];
for (const load of Object.keys(LOADS) as Load[]) {
  const atLoad = [];
  for (const leaseSize of [null, ...LEASE_SIZES]) {
    atLoad.push(await run(load, leaseSize));
    await sleep(200);
  }
  // Admitted, relative to the exact atomic limiter under the same load.
  const baseline = atLoad[0]!.admitted;
  for (const r of atLoad) rows.push({ ...r, admittedVsBaseline: Math.round((r.admitted / baseline) * 1000) / 1000 });
}

console.table(rows);
writeResult('leasing', {
  setup: { instances: INSTANCES, ratePerInstance: LOADS, durationMs: DURATION_MS, leaseTtlMs: LEASE_TTL_MS, bucket },
  rows,
});
connections.forEach((r) => r.disconnect());
