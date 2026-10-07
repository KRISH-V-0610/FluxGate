import { describe, expect, it } from 'vitest';
import {
  FixedWindowLimiter,
  GcraLimiter,
  SlidingWindowCounterLimiter,
  SlidingWindowLogLimiter,
  TokenBucketLimiter,
  type RateLimiter,
} from './index.js';

/** Every algorithm, configured as "10 units", so the same scenario runs against all five. */
const algorithms: [string, () => RateLimiter][] = [
  ['fixed window', () => new FixedWindowLimiter({ limit: 10, windowMs: 1000 })],
  ['sliding log', () => new SlidingWindowLogLimiter({ limit: 10, windowMs: 1000 })],
  ['sliding counter', () => new SlidingWindowCounterLimiter({ limit: 10, windowMs: 1000 })],
  ['token bucket', () => new TokenBucketLimiter({ capacity: 10, refillPerSecond: 10 })],
  ['GCRA', () => new GcraLimiter({ burst: 10, ratePerSecond: 10 })],
];

/** Tiny seeded PRNG (mulberry32), so random traffic is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(algorithms)('weighted cost: %s', (_name, make) => {
  it('a request of cost N uses N units, and a request that does not fit uses none', () => {
    const limiter = make();
    expect(limiter.consume('k', { now: 0, cost: 7 })).toMatchObject({ allowed: true, remaining: 3 });
    // 4 > 3 left: denied, and the 3 units are still there afterwards.
    expect(limiter.consume('k', { now: 0, cost: 4 })).toMatchObject({ allowed: false, remaining: 3 });
    expect(limiter.consume('k', { now: 0, cost: 3 })).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('retryAfterMs is exact for the cost asked: 1 ms earlier is denied, at retryAfterMs it is allowed', () => {
    const limiter = make();
    limiter.consume('k', { now: 0, cost: 10 });
    const denied = limiter.consume('k', { now: 0, cost: 4 });
    expect(denied.allowed).toBe(false);
    const retryAt = denied.retryAfterMs!;
    expect(retryAt).toBeGreaterThan(0);
    expect(limiter.consume('k', { now: retryAt - 1, cost: 4 }).allowed).toBe(false);
    expect(limiter.consume('k', { now: retryAt, cost: 4 }).allowed).toBe(true);
  });

  it('a cost above the limit is denied without retryAfterMs, because waiting can never help', () => {
    const denied = make().consume('k', { now: 0, cost: 11 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeUndefined();
  });

  it('rejects a cost that is not a positive whole number', () => {
    for (const cost of [0, -1, 1.5, Number.NaN]) {
      expect(() => make().consume('k', { now: 0, cost })).toThrow(RangeError);
    }
  });
});

describe('weighted cost keeps the guarantees', () => {
  it('sliding log: never more than the limit in units in any window, and never a false denial', () => {
    const limit = 50;
    const windowMs = 1000;
    const limiter = new SlidingWindowLogLimiter({ limit, windowMs });
    const rand = random(7);
    const admitted: { t: number; cost: number }[] = [];
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      t += Math.floor(rand() * 40);
      const cost = 1 + Math.floor(rand() * 8);
      // Brute force: units admitted in (t - windowMs, t].
      const inWindow = admitted.filter((a) => a.t > t - windowMs).reduce((sum, a) => sum + a.cost, 0);
      const allowed = limiter.consume('k', { now: t, cost }).allowed;
      expect(allowed, `t=${t} cost=${cost} inWindow=${inWindow}`).toBe(inWindow + cost <= limit);
      if (allowed) admitted.push({ t, cost });
    }
  });

  it('GCRA and the token bucket still make identical decisions with random costs', () => {
    const gcra = new GcraLimiter({ burst: 20, ratePerSecond: 5 });
    const bucket = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 5 });
    const rand = random(11);
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      t += Math.floor(rand() * 300);
      const cost = 1 + Math.floor(rand() * 6);
      expect(gcra.consume('k', { now: t, cost }).allowed, `t=${t} cost=${cost}`).toBe(
        bucket.consume('k', { now: t, cost }).allowed,
      );
    }
  });
});
