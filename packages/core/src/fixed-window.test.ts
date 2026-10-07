import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './fixed-window.js';

describe('FixedWindowLimiter', () => {
  it('allows up to the limit within one window, then denies', () => {
    const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 1000 });

    expect(limiter.consume('a', 100)).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.consume('a', 200)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('a', 300)).toMatchObject({ allowed: true, remaining: 0 });

    const denied = limiter.consume('a', 400);
    expect(denied).toMatchObject({ allowed: false, remaining: 0, limit: 3 });
    // The window is 0-999, so at t=400 the counter starts again in 600 ms.
    expect(denied.resetMs).toBe(600);
    expect(denied.retryAfterMs).toBe(600);
  });

  it('starts counting from zero when the next window begins', () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume('a', 10).allowed).toBe(true);
    expect(limiter.consume('a', 999).allowed).toBe(false);
    expect(limiter.consume('a', 1000).allowed).toBe(true);
  });

  it('keeps separate counters per key', () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume('alice', 0).allowed).toBe(true);
    expect(limiter.consume('bob', 0).allowed).toBe(true);
    expect(limiter.consume('alice', 1).allowed).toBe(false);
  });

  it('FAILURE MODE: lets 2x the limit through across a window boundary', () => {
    // Limit 3/s. Three requests at the very end of window 0, three at the very
    // start of window 1: six requests in 6 ms, all allowed.
    const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 1000 });
    const times = [997, 998, 999, 1000, 1001, 1002];
    const allowed = times.filter((t) => limiter.consume('a', t).allowed).length;
    expect(allowed).toBe(6);
  });

  it('rejects nonsense configuration up front', () => {
    expect(() => new FixedWindowLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new FixedWindowLimiter({ limit: 5, windowMs: Number.NaN })).toThrow(RangeError);
  });
});
