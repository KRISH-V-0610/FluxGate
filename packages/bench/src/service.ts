/**
 * Experiment 6: what does each layer of the toolkit cost per decision?
 *
 *  - in-process consume()   the bare limiter (the baseline)
 *  - in-process check()     + the @fluxgate/http layer: timeout race, headers,
 *                           Prometheus metrics. What every adapter pays.
 *  - HTTP hop only          fetch → a bare node:http server, no limiter: the
 *                           floor that any service on this machine pays.
 *  - service                @fluxgate/client → HTTP → the FluxGate server (a
 *                           separate process, as deployed) → its store. What
 *                           an app pays for not talking to Redis itself.
 *
 * Each at 1 request in flight (pure latency) and 64 in flight (under load),
 * on one hot key with a limit high enough that everything is allowed.
 * Redis calls per decision are read from the service's own /metrics.
 *
 * Requires: Redis (docker compose up -d redis) and a build (npm run build).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { TokenBucketLimiter, type AnyRateLimiter } from '@fluxgate/core';
import { createCheck, Metrics } from '@fluxgate/http';
import { FluxgateClient } from '@fluxgate/client';
import { connectRedis, RedisTokenBucket } from '@fluxgate/redis';
import { latencySummary, ROOT, sleep, writeResult } from './common.js';

const REQUESTS = { 1: 3000, 64: 20000 } as const;
const IN_FLIGHT = [1, 64] as const;
const config = { capacity: 1e9, refillPerSecond: 1e9 };
const TOKEN = 'bench-token';

interface Row {
  mode: string;
  store: string;
  inFlight: number;
  samples: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  throughputPerSec: number;
  redisCallsPerRequest: number;
}

/** Runs `total` operations with `inFlight` concurrent workers and times each one. */
async function measure(op: () => unknown, total: number, inFlight: number) {
  const samples: number[] = [];
  let issued = 0;
  const started = performance.now();
  const worker = async () => {
    while (issued < total) {
      issued++;
      const t0 = performance.now();
      await op();
      samples.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: inFlight }, worker));
  return { ...latencySummary(samples), throughputPerSec: Math.round(total / ((performance.now() - started) / 1000)) };
}

async function sweep(mode: string, store: string, op: () => unknown, redisCalls: () => Promise<number> | number): Promise<Row[]> {
  await measure(op, 1000, 8); // warm-up: JIT, connections, EVALSHA script cache
  const rows: Row[] = [];
  for (const inFlight of IN_FLIGHT) {
    const total = REQUESTS[inFlight];
    const before = await redisCalls();
    const result = await measure(op, total, inFlight);
    const calls = (await redisCalls()) - before;
    rows.push({ mode, store, inFlight, ...result, redisCallsPerRequest: Math.round((calls / total) * 1000) / 1000 });
    console.log(`  ${mode} / ${store} / ${inFlight} in flight: p50 ${result.p50} ms, p99 ${result.p99} ms, ${result.throughputPerSec}/s`);
  }
  return rows;
}

// ---- in process ---------------------------------------------------------------

const redis = await connectRedis({ commandTimeoutMs: 5000 });
const prefix = `bench:service:${randomUUID()}:`;
const rows: Row[] = [];

const inProcess: [string, AnyRateLimiter & { calls?: number }][] = [
  ['memory', new TokenBucketLimiter(config)],
  ['redis-lua', new RedisTokenBucket(redis, { ...config, prefix })],
];
for (const [store, limiter] of inProcess) {
  const calls = () => limiter.calls ?? 0;
  rows.push(...(await sweep('in-process consume()', store, () => limiter.consume('hot-key'), calls)));
  const check = createCheck({ limiter, metrics: new Metrics(), name: 'bench', timeoutMs: 5000 });
  rows.push(...(await sweep('in-process check() + metrics', store, () => check('hot-key'), calls)));
}
const leftovers = await redis.keys(`${prefix}*`);
if (leftovers.length > 0) await redis.del(...leftovers);

// ---- as a service ---------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Starts the real server (packages/server/dist/main.js) as its own process, like a deployment. */
async function startService(store: string): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [`${ROOT}packages/server/dist/main.js`], {
    env: {
      ...process.env,
      PORT: String(port),
      STORE: store,
      POLICIES: JSON.stringify({ bench: config }),
      SERVICE_TOKEN: TOKEN,
      LIMITER_TIMEOUT_MS: '5000',
      LEASE_SIZE: '20',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const client = new FluxgateClient({ url, token: TOKEN, timeoutMs: 1000 });
  // Ready when it answers a real check (Redis connects in the background).
  for (let i = 0; i < 100; i++) {
    try {
      await client.check({ policy: 'bench', key: 'ready' });
      return { url, child };
    } catch {
      await sleep(100);
    }
  }
  child.kill();
  throw new Error(`service with STORE=${store} did not become ready`);
}

/** Total Redis calls the service has made, from its Prometheus endpoint. */
async function serviceRedisCalls(url: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  return [...text.matchAll(/^fluxgate_redis_calls_total\{[^}]*\} (\S+)$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
}

// The floor: a bare node:http server that answers every POST with a fixed
// decision. Whatever the service costs beyond this is FluxGate's own share.
{
  const port = await freePort();
  const bare = `require('node:http').createServer((req, res) => { req.resume(); req.on('end', () => {
    res.setHeader('content-type', 'application/json'); res.end('{"allowed":true}'); }); }).listen(${port}, '127.0.0.1');`;
  const child = spawn(process.execPath, ['-e', bare], { stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}/v1/check`;
    const body = JSON.stringify({ policy: 'bench', key: 'hot-key' });
    const hop = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then((r) => r.json());
    for (let i = 0; i < 100; i++) {
      try {
        await hop();
        break;
      } catch {
        await sleep(100);
      }
    }
    rows.push(...(await sweep('HTTP hop only (bare node:http)', '-', hop, () => 0)));
  } finally {
    child.kill();
  }
}

for (const store of ['memory', 'redis-lua', 'redis-leased']) {
  const { url, child } = await startService(store);
  try {
    const limiter = new FluxgateClient({ url, token: TOKEN, timeoutMs: 5000 }).policy('bench');
    const key = `hot-key-${randomUUID()}`;
    rows.push(...(await sweep('service (HTTP)', store, () => limiter.consume(key), () => serviceRedisCalls(url))));
  } finally {
    child.kill();
  }
}
const serviceKeys = await redis.keys('fluxgate:bench:*');
if (serviceKeys.length > 0) await redis.del(...serviceKeys);
redis.disconnect();

console.table(rows);
writeResult('service', {
  setup: {
    note: `latency per decision in ms; client, service and Redis 7.4 (Docker Desktop) on one Windows 11 machine, Node ${process.version}`,
    requests: REQUESTS,
    leaseSize: 20,
  },
  rows,
});
