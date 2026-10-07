import { createRedisClient } from '@fluxgate/redis';
import { createApp } from './app.js';
import { buildLimiter, isStore, STORES } from './limiters.js';
import type { FailMode } from './middleware.js';
import { byTier, demoTierOf } from './tiers.js';

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

const redis = store === 'memory' ? undefined : createRedisClient({ url: env('REDIS_URL', 'redis://127.0.0.1:6379') });
redis?.on('error', (err) => console.error(`[${instanceId}] redis: ${err.message}`));
// With lazyConnect, connect in the background. Until it's ready, requests take the fail-mode path.
redis?.connect().catch(() => {});

const common = {
  store,
  redis,
  leaseSize: envNumber('LEASE_SIZE', 5),
  leaseTtlMs: envNumber('LEASE_TTL_MS', 1000),
} as const;

const free = buildLimiter({
  ...common,
  prefix: 'fluxgate:free:',
  config: { capacity: envNumber('FREE_CAPACITY', 20), refillPerSecond: envNumber('FREE_REFILL_PER_SEC', 2) },
});
const pro = buildLimiter({
  ...common,
  prefix: 'fluxgate:pro:',
  config: { capacity: envNumber('PRO_CAPACITY', 200), refillPerSecond: envNumber('PRO_REFILL_PER_SEC', 50) },
});

const app = createApp({
  limiter: byTier({ tiers: { free, pro }, tierOf: demoTierOf, fallback: 'free' }),
  failMode,
  timeoutMs: envNumber('LIMITER_TIMEOUT_MS', 200),
  instanceId,
  trustProxy: process.env.TRUST_PROXY ? envNumber('TRUST_PROXY', 1) : undefined,
  onError: (err) => console.error(`[${instanceId}] limiter failed (${failMode}): ${String(err)}`),
});

const server = app.listen(port, () => {
  console.log(`[${instanceId}] listening on :${port} store=${store} failMode=${failMode}`);
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
