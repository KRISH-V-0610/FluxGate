import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenBucketLimiter, type AnyRateLimiter, type AsyncRateLimiter } from '@flux-gate/core';
import type { FailMode } from './check.js';
import { fluxgate as expressMiddleware } from './express.js';
import { fluxgate as fastifyHook } from './fastify.js';
import { fluxgate as honoMiddleware } from './hono.js';
import { checkRequest, rejectionResponse, withRateLimit } from './fetch.js';

/**
 * The same scenarios run against every adapter, through each framework's real
 * request path (a listening Express server, Fastify's inject, Hono's
 * app.request, and plain Request objects for fetch).
 * The caller sends its key in x-api-key and the request's cost in x-cost.
 */
interface Reply {
  status: number;
  header: (name: string) => string | null;
  body: unknown;
}
type Send = (headers?: Record<string, string>) => Promise<Reply>;
type Harness = (options: { limiter: AnyRateLimiter; failMode?: FailMode }) => Promise<Send>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function fromResponse(res: Response): Promise<Reply> {
  return res.json().then((body) => ({ status: res.status, header: (n: string) => res.headers.get(n), body }));
}

const harnesses: [string, Harness][] = [
  [
    'express',
    async ({ limiter, failMode }) => {
      const app = express();
      app.use(expressMiddleware({ limiter, failMode, cost: (req) => Number(req.get('x-cost') ?? 1) }));
      app.get('/', (_req, res) => {
        res.json({ ok: true });
      });
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      cleanup.push(() => server.close());
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      return async (headers) => fromResponse(await fetch(url, { headers }));
    },
  ],
  [
    'fastify',
    async ({ limiter, failMode }) => {
      const app = Fastify();
      app.addHook('onRequest', fastifyHook({ limiter, failMode, cost: (req) => Number(req.headers['x-cost'] ?? 1) }));
      app.get('/', async () => ({ ok: true }));
      await app.ready();
      cleanup.push(() => app.close());
      return async (headers) => {
        const res = await app.inject({ method: 'GET', url: '/', headers });
        return {
          status: res.statusCode,
          header: (n) => (res.headers[n.toLowerCase()] === undefined ? null : String(res.headers[n.toLowerCase()])),
          body: res.json(),
        };
      };
    },
  ],
  [
    'hono',
    async ({ limiter, failMode }) => {
      const app = new Hono();
      app.use(
        '*',
        honoMiddleware({
          limiter,
          failMode,
          key: (c) => c.req.header('x-api-key') ?? 'anonymous',
          cost: (c) => Number(c.req.header('x-cost') ?? 1),
        }),
      );
      app.get('/', (c) => c.json({ ok: true }));
      return async (headers) => fromResponse(await app.request('/', { headers }));
    },
  ],
  [
    'fetch (Next.js, Bun, Deno, Workers)',
    async ({ limiter, failMode }) => {
      const handler = withRateLimit(
        {
          limiter,
          failMode,
          key: (req) => req.headers.get('x-api-key') ?? 'anonymous',
          cost: (req) => Number(req.headers.get('x-cost') ?? 1),
        },
        async () => Response.json({ ok: true }),
      );
      return async (headers) => fromResponse(await handler(new Request('http://localhost/', { headers })));
    },
  ],
];

const broken: AsyncRateLimiter = { consume: () => Promise.reject(new Error('ECONNREFUSED')) };

describe.each(harnesses)('adapter: %s', (_name, harness) => {
  it('allows up to the limit with X-RateLimit headers, then answers 429 with Retry-After', async () => {
    const send = await harness({ limiter: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }) });
    const first = await send({ 'x-api-key': 'alice' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(first.header('x-ratelimit-limit')).toBe('2');
    expect(first.header('x-ratelimit-remaining')).toBe('1');

    expect((await send({ 'x-api-key': 'alice' })).status).toBe(200);
    const third = await send({ 'x-api-key': 'alice' });
    expect(third.status).toBe(429);
    expect(third.header('retry-after')).toBe('1');
    expect(third.header('x-ratelimit-remaining')).toBe('0');
    expect(third.body).toMatchObject({ error: 'rate_limited' });

    // Someone else has their own bucket.
    expect((await send({ 'x-api-key': 'bob' })).status).toBe(200);
  });

  it('charges the request cost, and answers 413 when the cost can never fit', async () => {
    const send = await harness({ limiter: new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }) });
    const big = await send({ 'x-api-key': 'a', 'x-cost': '8' });
    expect(big.status).toBe(200);
    expect(big.header('x-ratelimit-remaining')).toBe('2');
    expect((await send({ 'x-api-key': 'a', 'x-cost': '3' })).status).toBe(429);
    const huge = await send({ 'x-api-key': 'b', 'x-cost': '11' });
    expect(huge.status).toBe(413);
    expect(huge.body).toEqual({ error: 'cost_exceeds_limit', cost: 11, limit: 10 });
  });

  it('fail-open serves the request marked degraded; fail-closed answers 503', async () => {
    const open = await (await harness({ limiter: broken, failMode: 'open' }))();
    expect(open.status).toBe(200);
    expect(open.header('x-ratelimit-status')).toBe('degraded');

    const closed = await (await harness({ limiter: broken, failMode: 'closed' }))();
    expect(closed.status).toBe(503);
    expect(closed.header('x-ratelimit-status')).toBe('degraded');
    expect(closed.body).toEqual({ error: 'rate_limiter_unavailable' });
  });
});

describe('adapter details', () => {
  it('express: an invalid cost goes to the error handler instead of being treated as a limiter outage', async () => {
    const app = express();
    app.use(expressMiddleware({ limiter: broken, failMode: 'open', cost: () => -1 }));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.name });
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    cleanup.push(() => server.close());
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'RangeError' });
  });

  it('fastify: as a preHandler, the cost can come from the parsed JSON body', async () => {
    const app = Fastify();
    const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 });
    app.post(
      '/chat',
      { preHandler: fastifyHook({ limiter, cost: (req) => (req.body as { maxTokens: number }).maxTokens }) },
      async () => ({ ok: true }),
    );
    cleanup.push(() => app.close());
    const post = (maxTokens: number) => app.inject({ method: 'POST', url: '/chat', payload: { maxTokens } });
    expect((await post(6)).headers['x-ratelimit-remaining']).toBe('4');
    expect((await post(6)).statusCode).toBe(429);
  });

  it('hono: headers survive a handler that returns a plain Response', async () => {
    const app = new Hono();
    app.use('*', honoMiddleware({ limiter: new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 }), key: () => 'k' }));
    app.get('/', () => new Response('raw'));
    const res = await app.request('/');
    expect(await res.text()).toBe('raw');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });

  it('fetch: adds headers even to a response whose headers are read-only, and passes extra arguments through', async () => {
    const handler = withRateLimit(
      { limiter: new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 }), key: () => 'k' },
      async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
        Response.redirect(`http://localhost/items/${(await ctx.params).id}`, 302),
    );
    const res = await handler(new Request('http://localhost/'), { params: Promise.resolve({ id: '42' }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/items/42');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('4');
  });

  it('fetch: checkRequest + rejectionResponse for middleware-style code', async () => {
    const limit = checkRequest({ limiter: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }), key: () => 'k' });
    expect((await limit(new Request('http://localhost/'))).allowed).toBe(true);
    const decision = await limit(new Request('http://localhost/'));
    if (decision.allowed) throw new Error('expected a denial');
    const res = rejectionResponse(decision);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
