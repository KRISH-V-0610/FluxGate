import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenBucketLimiter, type AsyncRateLimiter } from '@fluxgate/core';
import { byTier, Metrics } from '@fluxgate/http';
import { fluxgate } from '@fluxgate/http/express';
import { FluxgateClient } from '@fluxgate/client';
import { createApp, type AppOptions } from './app.js';
import { parsePolicies } from './policies.js';
import { demoTierOf } from './tiers.js';

/** Start a real Express app on a random free port and return its base URL. */
const servers: Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const start = (options: AppOptions) => listen(createApp(options));
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const brokenStore: AsyncRateLimiter = {
  consume: () => Promise.reject(new Error('ECONNREFUSED redis:6379')),
};
const hangingStore: AsyncRateLimiter = {
  consume: () => new Promise(() => {}),
};
const bucket = (capacity: number, refillPerSecond = 0.01) => new TokenBucketLimiter({ capacity, refillPerSecond });

describe('demo API', () => {
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
    const url = await start({ limiter: bucket(1) });
    const as = (key: string) => fetch(`${url}/api/hello`, { headers: { 'x-api-key': key } });
    expect((await as('alice')).status).toBe(200);
    expect((await as('alice')).status).toBe(429);
    expect((await as('bob')).status).toBe(200);
  });

  it('never rate limits the health check', async () => {
    const url = await start({ limiter: bucket(1) });
    await fetch(`${url}/api/hello`);
    for (let i = 0; i < 5; i++) expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('applies per-key tiers: pro keys get a bigger bucket than free keys', async () => {
    const limiter = byTier({ tiers: { free: bucket(2), pro: bucket(5) }, tierOf: demoTierOf, fallback: 'free' });
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

describe('GET /metrics', () => {
  it('serves Prometheus text with the decisions of the API and the service', async () => {
    const metrics = new Metrics().counter('fluxgate_redis_calls_total', 'Calls.', () => 3);
    const url = await start({ limiter: bucket(1), metrics, service: { policies: { free: bucket(5) } } });
    await fetch(`${url}/api/hello`);
    await fetch(`${url}/api/hello`);
    await fetch(`${url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"policy":"free","key":"k","cost":2}' });

    const res = await fetch(`${url}/metrics`);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('fluxgate_decisions_total{limiter="api",outcome="allowed"} 1');
    expect(text).toContain('fluxgate_decisions_total{limiter="api",outcome="denied"} 1');
    expect(text).toContain('fluxgate_cost_units_total{limiter="free",outcome="allowed"} 2');
    expect(text).toContain('fluxgate_redis_calls_total 3');
  });

  it('is not served when no registry is configured', async () => {
    const url = await start({ limiter: bucket(1) });
    expect((await fetch(`${url}/metrics`)).status).toBe(404);
  });
});

describe('rate-limit service: POST /v1/check', () => {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const service = (policies: AppOptions['service'] extends infer S ? S : never) => start({ limiter: bucket(1), service: policies });

  it('answers 200 with the decision, for an allow and for a deny', async () => {
    const url = await service({ policies: { free: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }) } });
    expect(await (await post(url, { policy: 'free', key: 'user:1' })).json()).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetMs: 1000,
    });
    await post(url, { policy: 'free', key: 'user:1' });
    const denied = await post(url, { policy: 'free', key: 'user:1' });
    expect(denied.status).toBe(200);
    const body = await denied.json();
    expect(body).toMatchObject({ allowed: false, remaining: 0 });
    // Real clock: up to 1 s, minus the few ms since the first request.
    expect(body.retryAfterMs).toBeGreaterThan(900);
    expect(body.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('keeps each policy separate and charges the cost', async () => {
    const url = await service({ policies: { free: bucket(10), login: bucket(3) } });
    expect(await (await post(url, { policy: 'free', key: 'k', cost: 4 })).json()).toMatchObject({ remaining: 6 });
    expect(await (await post(url, { policy: 'login', key: 'k' })).json()).toMatchObject({ limit: 3, remaining: 2 });
    // Bigger than the whole limit: a denial with no retryAfterMs, which adapters turn into 413.
    const huge = await (await post(url, { policy: 'login', key: 'k', cost: 4 })).json();
    expect(huge).toMatchObject({ allowed: false });
    expect(huge.retryAfterMs).toBeUndefined();
  });

  it('rejects bad requests with 400 and says why', async () => {
    const url = await service({ policies: { free: bucket(10) } });
    const cases: [unknown, string][] = [
      [{ policy: 'gold', key: 'k' }, 'unknown_policy'],
      [{ key: 'k' }, 'unknown_policy'],
      [{ policy: 'free' }, 'invalid_request'],
      [{ policy: 'free', key: '' }, 'invalid_request'],
      [{ policy: 'free', key: 'x'.repeat(257) }, 'invalid_request'],
      [{ policy: 'free', key: 'k', cost: 0 }, 'invalid_request'],
      [{ policy: 'free', key: 'k', cost: 1.5 }, 'invalid_request'],
      [{ policy: 'free', key: 'k', cost: '3' }, 'invalid_request'],
      ['{not json', 'invalid_request'],
      ['[]', 'invalid_request'],
    ];
    for (const [body, error] of cases) {
      const res = await post(url, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json(), JSON.stringify(body)).toMatchObject({ error });
    }
    expect(await (await post(url, { policy: 'gold', key: 'k' })).json()).toMatchObject({ policies: ['free'] });
  });

  it('requires the bearer token when one is configured', async () => {
    const url = await service({ policies: { free: bucket(10) }, token: 's3cret' });
    expect((await post(url, { policy: 'free', key: 'k' })).status).toBe(401);
    expect((await post(url, { policy: 'free', key: 'k' }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(url, { policy: 'free', key: 'k' }, { authorization: 's3cret' })).status).toBe(401);
    expect((await post(url, { policy: 'free', key: 'k' }, { authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('answers 503 when the store is down, whatever the API fail mode is', async () => {
    const url = await start({ limiter: bucket(1), failMode: 'open', service: { policies: { free: brokenStore } } });
    const res = await post(url, { policy: 'free', key: 'k' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'rate_limiter_unavailable' });
  });
});

describe('end to end: an app limited through the service with @fluxgate/client', () => {
  async function appUsing(serviceUrl: string, failMode: 'open' | 'closed' = 'open') {
    const client = new FluxgateClient({ url: serviceUrl, token: 't0ken' });
    const app = express();
    app.post('/chat', express.json(), fluxgate({ limiter: client.policy('llm'), failMode, cost: (req) => req.body.tokens }), (_req, res) => {
      res.json({ ok: true });
    });
    const url = await listen(app);
    return (tokens: number) =>
      fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'team-a' }, body: JSON.stringify({ tokens }) });
  }

  it('uses the shared budget, answers 429 and 413 like a local limiter would', async () => {
    const serviceUrl = await start({ limiter: bucket(1), service: { policies: { llm: bucket(1000) }, token: 't0ken' } });
    const chat = await appUsing(serviceUrl);
    const first = await chat(600);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-remaining')).toBe('400');
    expect((await chat(500)).status).toBe(429);
    expect((await chat(400)).status).toBe(200);
    expect((await chat(5000)).status).toBe(413);
  });

  it('two apps share one budget, because the state lives in the service', async () => {
    const serviceUrl = await start({ limiter: bucket(1), service: { policies: { llm: bucket(1000) }, token: 't0ken' } });
    const appA = await appUsing(serviceUrl);
    const appB = await appUsing(serviceUrl);
    expect((await appA(700)).status).toBe(200);
    expect((await appB(700)).status).toBe(429);
  });

  it("when the service is unreachable, the app's own fail mode decides", async () => {
    const deadUrl = 'http://127.0.0.1:9'; // discard port: nothing listens
    expect((await (await appUsing(deadUrl, 'open'))(1)).headers.get('x-ratelimit-status')).toBe('degraded');
    expect((await (await appUsing(deadUrl, 'closed'))(1)).status).toBe(503);
  });
});

describe('parsePolicies', () => {
  it('reads named token-bucket policies from JSON', () => {
    expect(parsePolicies('{"free":{"capacity":20,"refillPerSecond":2},"login":{"capacity":5,"refillPerSecond":0.1}}')).toEqual({
      free: { capacity: 20, refillPerSecond: 2 },
      login: { capacity: 5, refillPerSecond: 0.1 },
    });
  });

  it('explains what is wrong with bad config', () => {
    expect(() => parsePolicies('nope')).toThrow(/valid JSON/);
    expect(() => parsePolicies('{}')).toThrow(/non-empty/);
    expect(() => parsePolicies('[]')).toThrow(/non-empty/);
    expect(() => parsePolicies('{"a b":{"capacity":1,"refillPerSecond":1}}')).toThrow(/letters, digits/);
    expect(() => parsePolicies('{"free":{"capacity":"20","refillPerSecond":2}}')).toThrow(/numeric/);
    expect(() => parsePolicies('{"free":null}')).toThrow(/numeric/);
  });
});
