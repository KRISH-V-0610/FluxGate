import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenBucketLimiter, type AsyncRateLimiter } from '@fluxgate/core';
import { createApp, type AppOptions } from './app.js';
import { byTier, demoTierOf } from './tiers.js';

/** Start the real Express app on a random free port and return its base URL. */
let server: Server | undefined;
async function start(options: AppOptions): Promise<string> {
  const app = createApp(options);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => {
  server?.close();
  server = undefined;
});

const brokenStore: AsyncRateLimiter = {
  consume: () => Promise.reject(new Error('ECONNREFUSED redis:6379')),
};
const hangingStore: AsyncRateLimiter = {
  consume: () => new Promise(() => {}),
};

describe('fluxgate middleware', () => {
  it('sets X-RateLimit-* headers and returns 429 + Retry-After once the limit is hit', async () => {
    const url = await start({ limiter: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }) });

    const first = await fetch(`${url}/api/hello`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('2');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1');

    await fetch(`${url}/api/hello`);
    const third = await fetch(`${url}/api/hello`);
    expect(third.status).toBe(429);
    expect(third.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(third.headers.get('retry-after')).toBe('1');
    expect(await third.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('limits each API key separately', async () => {
    const url = await start({ limiter: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.01 }) });
    const as = (key: string) => fetch(`${url}/api/hello`, { headers: { 'x-api-key': key } });
    expect((await as('alice')).status).toBe(200);
    expect((await as('alice')).status).toBe(429);
    expect((await as('bob')).status).toBe(200);
  });

  it('never rate limits the health check', async () => {
    const url = await start({ limiter: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.01 }) });
    await fetch(`${url}/api/hello`);
    for (let i = 0; i < 5; i++) expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('applies per-key tiers: pro keys get a bigger bucket than free keys', async () => {
    const limiter = byTier({
      tiers: {
        free: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 0.01 }),
        pro: new TokenBucketLimiter({ capacity: 5, refillPerSecond: 0.01 }),
      },
      tierOf: demoTierOf,
      fallback: 'free',
    });
    const url = await start({ limiter });
    const count = async (key: string) => {
      let ok = 0;
      for (let i = 0; i < 10; i++) {
        if ((await fetch(`${url}/api/hello`, { headers: { 'x-api-key': key } })).status === 200) ok++;
      }
      return ok;
    };
    expect(await count('free_abc')).toBe(2);
    expect(await count('pro_xyz')).toBe(5);
  });

  it('fail-open: when the store is down, requests still succeed but are marked degraded', async () => {
    const errors: unknown[] = [];
    const url = await start({ limiter: brokenStore, failMode: 'open', onError: (e) => errors.push(e) });
    const res = await fetch(`${url}/api/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-status')).toBe('degraded');
    expect(errors).toHaveLength(1);
  });

  it('fail-closed: when the store is down, requests are rejected with 503', async () => {
    const url = await start({ limiter: brokenStore, failMode: 'closed' });
    const res = await fetch(`${url}/api/hello`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'rate_limiter_unavailable' });
  });

  it('treats a hanging store as failed after timeoutMs instead of hanging the request', async () => {
    const url = await start({ limiter: hangingStore, failMode: 'open', timeoutMs: 50 });
    const started = performance.now();
    const res = await fetch(`${url}/api/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-status')).toBe('degraded');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
