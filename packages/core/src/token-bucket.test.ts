import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from './token-bucket.js';

describe('TokenBucketLimiter', () => {
  it('allows a burst up to capacity, then denies', () => {
    const limiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume('a', { now: 0 })).toMatchObject({ allowed: true, remaining: 4 - i });
    }
    const denied = limiter.consume('a', { now: 0 });
    expect(denied).toMatchObject({ allowed: false, remaining: 0, limit: 5 });
    // Empty bucket at 1 token/s: one token in 1000 ms, completely full in 5000 ms.
    expect(denied.retryAfterMs).toBe(1000);
    expect(denied.resetMs).toBe(5000);
  });

  it('refills continuously: 250 ms earns a quarter of a token', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(limiter.consume('a', { now: 0 }).allowed).toBe(true);

    const partial = limiter.consume('a', { now: 250 });
    expect(partial.allowed).toBe(false);
    // 0.25 tokens are in the bucket; 0.75 more are needed.
    expect(partial.retryAfterMs).toBe(750);

    expect(limiter.consume('a', { now: 1000 }).allowed).toBe(true);
  });

  it('never refills past capacity, however long the key was idle', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 10 });
    const decisions = Array.from({ length: 5 }, () => limiter.consume('a', { now: 3_600_000 }).allowed);
    expect(decisions).toEqual([true, true, true, false, false]);
  });

  it('sustains exactly the refill rate under constant pressure', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 10 });
    let allowed = 0;
    // Hammer every 1 ms for 10 s: expect 1 (initial token) + 10/s * 10 s.
    for (let t = 0; t <= 10_000; t++) if (limiter.consume('a', { now: t }).allowed) allowed++;
    expect(allowed).toBe(101);
  });

  it('does not mint tokens if the clock jumps backwards', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(limiter.consume('a', { now: 10_000 }).allowed).toBe(true);
    expect(limiter.consume('a', { now: 5_000 }).allowed).toBe(false);
  });
});
