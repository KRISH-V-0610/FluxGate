import { describe, expect, it } from 'vitest';
import { SlidingWindowLogLimiter } from './sliding-window-log.js';

describe('SlidingWindowLogLimiter', () => {
  it('allows up to the limit, then denies until the oldest request slides out', () => {
    const limiter = new SlidingWindowLogLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.consume('a', { now: 0 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('a', { now: 300 })).toMatchObject({ allowed: true, remaining: 0 });

    const denied = limiter.consume('a', { now: 500 });
    expect(denied.allowed).toBe(false);
    // The request at t=0 leaves the window (t-1000, t] at t=1000.
    expect(denied.retryAfterMs).toBe(500);
    expect(denied.resetMs).toBe(800);

    expect(limiter.consume('a', { now: 999 }).allowed).toBe(false);
    expect(limiter.consume('a', { now: 1000 }).allowed).toBe(true);
  });

  it('does NOT have the boundary burst: same timestamps as the fixed-window test', () => {
    const limiter = new SlidingWindowLogLimiter({ limit: 3, windowMs: 1000 });
    const times = [997, 998, 999, 1000, 1001, 1002];
    const decisions = times.map((t) => limiter.consume('a', { now: t }).allowed);
    expect(decisions).toEqual([true, true, true, false, false, false]);
  });

  it('never admits more than the limit in ANY window of windowMs', () => {
    const limiter = new SlidingWindowLogLimiter({ limit: 5, windowMs: 1000 });
    const admitted: number[] = [];
    for (let t = 0; t < 10_000; t += 37) {
      if (limiter.consume('a', { now: t }).allowed) admitted.push(t);
    }
    for (const start of admitted) {
      const inWindow = admitted.filter((t) => t >= start && t < start + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(5);
    }
  });
});
