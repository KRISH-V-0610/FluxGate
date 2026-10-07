/**
 * Experiment 5: what happens to the API when Redis stops responding?
 *
 * Runs the real Express app in-process with the atomic Redis limiter and
 * sends 200 req/s (open loop) for 9 s. At t=3 s we `docker compose pause
 * redis` (it freezes: TCP stays open, no replies, the nastiest failure
 * because nothing errors, it just hangs). At t=6 s we unpause it.
 *
 * Three configurations:
 *  - library defaults: stock ioredis client, no middleware timeout
 *  - fail-open:   fast-failing client + 100 ms limiter timeout, let traffic through
 *  - fail-closed: same, but reject with 503
 *
 * For each 500 ms slice we record status codes and p99 latency.
 *
 * Requires Redis via docker compose (it pauses/unpauses the `redis` service).
 */
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { connectRedis, RedisTokenBucket } from '@flux-gate/redis';
import type { FailMode } from '@flux-gate/http';
import { createApp } from '@flux-gate/server';
import { docker, mulberry32, openLoop, percentile, sleep, writeResult } from './common.js';

const RATE = 200;
const DURATION_MS = 9000;
const PAUSE_AT = 3000;
const RESUME_AT = 6000;
const SLICE_MS = 500;
const config = { capacity: 1e9, refillPerSecond: 1e9, prefix: 'bench:failover:' };

interface Variant {
  name: string;
  failMode: FailMode;
  timeoutMs: number;
  redis: () => Promise<Redis>;
}

const variants: Variant[] = [
  {
    name: 'library defaults',
    failMode: 'open',
    timeoutMs: 60_000,
    redis: async () => {
      const r = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
      r.on('error', () => {});
      await new Promise((resolve) => r.once('ready', resolve));
      return r;
    },
  },
  { name: 'fail-open', failMode: 'open', timeoutMs: 100, redis: () => connectRedis({ commandTimeoutMs: 100 }) },
  { name: 'fail-closed', failMode: 'closed', timeoutMs: 100, redis: () => connectRedis({ commandTimeoutMs: 100 }) },
];

async function run(variant: Variant) {
  const redis = await variant.redis();
  const app = createApp({
    limiter: new RedisTokenBucket(redis, config),
    failMode: variant.failMode,
    timeoutMs: variant.timeoutMs,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hello`;

  const records: { sentAt: number; status: number; degraded: boolean; ms: number }[] = [];
  const pending: Promise<void>[] = [];
  // Record when the docker commands actually took effect (they take a few hundred ms).
  const start = performance.now();
  const actual = { pausedAtMs: 0, resumedAtMs: 0 };
  const timers = [
    setTimeout(() => void docker('pause redis').then(() => (actual.pausedAtMs = Math.round(performance.now() - start))), PAUSE_AT),
    setTimeout(() => void docker('unpause redis').then(() => (actual.resumedAtMs = Math.round(performance.now() - start))), RESUME_AT),
  ];

  try {
    await openLoop(RATE, DURATION_MS, mulberry32(9), (sentAt) => {
      const t0 = performance.now();
      pending.push(
        fetch(url, { signal: AbortSignal.timeout(15_000) })
          .then(async (res) => {
            await res.arrayBuffer();
            records.push({ sentAt, status: res.status, degraded: res.headers.get('x-ratelimit-status') === 'degraded', ms: performance.now() - t0 });
          })
          .catch(() => {
            records.push({ sentAt, status: 0, degraded: false, ms: performance.now() - t0 });
          }),
      );
    });
    await Promise.all(pending);
  } finally {
    timers.forEach(clearTimeout);
    await docker('unpause redis'); // no-op if already running
    server.closeAllConnections();
    server.close();
    redis.disconnect();
  }

  const slices = [];
  for (let from = 0; from < DURATION_MS; from += SLICE_MS) {
    const inSlice = records.filter((r) => r.sentAt >= from && r.sentAt < from + SLICE_MS);
    slices.push({
      t: from / 1000,
      redis: from >= PAUSE_AT && from < RESUME_AT ? 'paused' : 'up',
      ok: inSlice.filter((r) => r.status === 200 && !r.degraded).length,
      degraded: inSlice.filter((r) => r.degraded && r.status === 200).length,
      rejected503: inSlice.filter((r) => r.status === 503).length,
      p99ms: Math.round(percentile(inSlice.map((r) => r.ms), 99)),
    });
  }
  const during = records.filter((r) => r.sentAt >= PAUSE_AT && r.sentAt < RESUME_AT);
  return {
    variant: variant.name,
    actual,
    summary: {
      requestsDuringOutage: during.length,
      servedDuringOutagePct: Math.round((during.filter((r) => r.status === 200).length / during.length) * 1000) / 10,
      p50DuringOutageMs: Math.round(percentile(during.map((r) => r.ms), 50)),
      p99DuringOutageMs: Math.round(percentile(during.map((r) => r.ms), 99)),
    },
    slices,
  };
}

const results = [];
for (const variant of variants) {
  console.log(`running: ${variant.name}`);
  results.push(await run(variant));
  await sleep(2000); // let Redis settle and clients reconnect between runs
}

console.table(results.map((r) => ({ variant: r.variant, ...r.summary })));
writeResult('failover', {
  setup: { ratePerSecond: RATE, durationMs: DURATION_MS, pausedFromMs: PAUSE_AT, resumedAtMs: RESUME_AT },
  results,
});
