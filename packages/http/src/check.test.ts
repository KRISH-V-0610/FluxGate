import { describe, expect, it, vi } from 'vitest';
import { TokenBucketLimiter, type AsyncRateLimiter, type RateLimitResult } from '@flux-gate/core';
import { createCheck } from './check.js';
import { Metrics } from './metrics.js';

const broken: AsyncRateLimiter = { consume: () => Promise.reject(new Error('ECONNREFUSED redis:6379')) };
const hanging: AsyncRateLimiter = { consume: () => new Promise<RateLimitResult>(() => {}) };

describe('createCheck', () => {
  it('allows with X-RateLimit headers, then denies with 429 and Retry-After', async () => {
    const check = createCheck({ limiter: new TokenBucketLimiter({ capacity: 2, refillPerSecond: 1 }) });

    const first = await check('k');
    expect(first).toMatchObject({ allowed: true, outcome: 'allowed' });
    expect(first.headers).toEqual({ 'X-RateLimit-Limit': '2', 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset': '1' });

    await check('k');
    const third = await check('k');
    expect(third).toMatchObject({
      allowed: false,
      outcome: 'denied',
      rejection: { status: 429, body: { error: 'rate_limited', retryAfterSeconds: 1 } },
    });
    expect(third.headers['Retry-After']).toBe('1');
  });

  it('a cost bigger than the whole limit gets 413, not 429, because retrying can never succeed', async () => {
    const check = createCheck({ limiter: new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }) });
    const decision = await check('k', { cost: 11 });
    expect(decision).toMatchObject({
      allowed: false,
      rejection: { status: 413, body: { error: 'cost_exceeds_limit', cost: 11, limit: 10 } },
    });
    expect(decision.headers['Retry-After']).toBeUndefined();
    // Nothing was used up by the rejected request.
    expect(await check('k', { cost: 10 })).toMatchObject({ allowed: true });
  });

  it('passes the cost to the limiter', async () => {
    const check = createCheck({ limiter: new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }) });
    expect((await check('k', { cost: 7 })).headers['X-RateLimit-Remaining']).toBe('3');
  });

  it('throws on an invalid cost instead of hiding the bug behind fail-open', async () => {
    const check = createCheck({ limiter: broken, failMode: 'open' });
    await expect(check('k', { cost: 0 })).rejects.toThrow(RangeError);
    await expect(check('k', { cost: 2.5 })).rejects.toThrow(RangeError);
  });

  it('fail-open: a broken store lets the request through, marked degraded', async () => {
    const onError = vi.fn();
    const check = createCheck<{ path: string }>({ limiter: broken, failMode: 'open', onError });
    const decision = await check('k', { context: { path: '/x' } });
    expect(decision).toMatchObject({ allowed: true, outcome: 'degraded', headers: { 'X-RateLimit-Status': 'degraded' } });
    expect(decision.result).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'k', { path: '/x' });
  });

  it('fail-closed: a broken store rejects with 503', async () => {
    const decision = await createCheck({ limiter: broken, failMode: 'closed' })('k');
    expect(decision).toMatchObject({
      allowed: false,
      outcome: 'unavailable',
      rejection: { status: 503, body: { error: 'rate_limiter_unavailable' } },
    });
  });

  it('treats a hanging store as failed after timeoutMs', async () => {
    const check = createCheck({ limiter: hanging, timeoutMs: 30 });
    const started = performance.now();
    expect(await check('k')).toMatchObject({ outcome: 'degraded' });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('picks a limiter per caller when given a function', async () => {
    const small = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.01 });
    const big = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 0.01 });
    const check = createCheck<{ plan: string }>({ limiter: (_key, ctx) => (ctx.plan === 'pro' ? big : small) });
    expect((await check('a', { context: { plan: 'free' } })).headers['X-RateLimit-Limit']).toBe('1');
    expect((await check('b', { context: { plan: 'pro' } })).headers['X-RateLimit-Limit']).toBe('5');
  });

  it('records every decision in the metrics registry, under its name', async () => {
    const metrics = new Metrics();
    const check = createCheck({ limiter: new TokenBucketLimiter({ capacity: 3, refillPerSecond: 0.01 }), metrics, name: 'api' });
    createCheck({ limiter: broken, metrics, name: 'login', failMode: 'closed' })('k');
    await check('k', { cost: 2 });
    await check('k', { cost: 2 });
    const text = metrics.render();
    expect(text).toContain('fluxgate_decisions_total{limiter="api",outcome="allowed"} 1');
    expect(text).toContain('fluxgate_decisions_total{limiter="api",outcome="denied"} 1');
    expect(text).toContain('fluxgate_cost_units_total{limiter="api",outcome="allowed"} 2');
    expect(text).toContain('fluxgate_cost_units_total{limiter="api",outcome="denied"} 2');
    // Declared at creation, so it shows up even before its first decision is recorded.
    expect(text).toContain('fluxgate_decisions_total{limiter="login",outcome="unavailable"}');
  });
});
