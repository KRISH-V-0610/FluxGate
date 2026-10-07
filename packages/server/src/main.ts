import { createRedisClient } from '@fluxgate/redis';
import { byTier, Metrics, type FailMode } from '@fluxgate/http';
import { createApp } from './app.js';
import { buildLimiter, isStore, redisCalls, STORES } from './limiters.js';
import { parsePolicies, type Policies } from './policies.js';
import { demoTierOf } from './tiers.js';

/** All configuration comes from environment variables (12-factor), so Docker Compose can set it. */
function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
function envNumber(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

const store = env('STORE', 'redis-lua');
if (!isStore(store)) throw new Error(`STORE must be one of ${STORES.join(', ')}, got "${store}"`);
const failMode = env('FAIL_MODE', 'open') as FailMode;
if (failMode !== 'open' && failMode !== 'closed') throw new Error('FAIL_MODE must be open or closed');

const port = envNumber('PORT', 3000);
const instanceId = env('INSTANCE_ID', `pid-${process.pid}`);
const timeoutMs = envNumber('LIMITER_TIMEOUT_MS', 200);

const redis = store === 'memory' ? undefined : createRedisClient({ url: env('REDIS_URL', 'redis://127.0.0.1:6379') });
redis?.on('error', (err) => console.error(`[${instanceId}] redis: ${err.message}`));
// With lazyConnect, connect in the background. Until it's ready, requests take the fail-mode path.
redis?.connect().catch(() => {});

// Named policies. Without POLICIES, the two demo tiers come from their own variables.
const config: Policies = process.env.POLICIES
  ? parsePolicies(process.env.POLICIES)
  : {
      free: { capacity: envNumber('FREE_CAPACITY', 20), refillPerSecond: envNumber('FREE_REFILL_PER_SEC', 2) },
      pro: { capacity: envNumber('PRO_CAPACITY', 200), refillPerSecond: envNumber('PRO_REFILL_PER_SEC', 50) },
    };
const policies = Object.fromEntries(
  Object.entries(config).map(([name, bucket]) => [
    name,
    buildLimiter({
      store,
      redis,
      prefix: `fluxgate:${name}:`,
      config: bucket,
      leaseSize: envNumber('LEASE_SIZE', 5),
      leaseTtlMs: envNumber('LEASE_TTL_MS', 1000),
    }),
  ]),
);

const metrics = new Metrics().counter('fluxgate_redis_calls_total', 'Commands sent to Redis by the limiters, by policy.', () =>
  Object.entries(policies).map(([policy, limiter]) => ({ labels: { policy }, value: redisCalls(limiter) })),
);

const token = process.env.SERVICE_TOKEN || undefined;
if (!token) console.warn(`[${instanceId}] SERVICE_TOKEN is not set: anyone who can reach this port can call POST /v1/check`);

const app = createApp({
  // The demo API: keys starting with pro_ get the "pro" policy, everyone else the first one ("free" by default).
  limiter: byTier({ tiers: policies, tierOf: demoTierOf, fallback: 'free' in policies ? 'free' : Object.keys(policies)[0]! }),
  failMode,
  timeoutMs,
  instanceId,
  trustProxy: process.env.TRUST_PROXY ? envNumber('TRUST_PROXY', 1) : undefined,
  metrics,
  onError: (err) => console.error(`[${instanceId}] limiter failed (${failMode}): ${String(err)}`),
  service: {
    policies,
    token,
    timeoutMs,
    onError: (err, policy) => console.error(`[${instanceId}] policy ${policy}: store unavailable: ${String(err)}`),
  },
});

const server = app.listen(port, () => {
  console.log(`[${instanceId}] listening on :${port} store=${store} failMode=${failMode} policies=${Object.keys(policies).join(',')}`);
});

// Graceful shutdown: stop accepting connections, finish in-flight ones, then close Redis.
function shutdown(signal: string) {
  console.log(`[${instanceId}] ${signal} received, shutting down`);
  server.close(() => {
    redis?.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
