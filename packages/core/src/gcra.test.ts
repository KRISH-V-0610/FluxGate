import { describe, expect, it } from 'vitest';
import { GcraLimiter } from './gcra.js';
import { TokenBucketLimiter } from './token-bucket.js';

/** Small seeded PRNG (mulberry32) so the "random" traffic is the same on every run. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('GcraLimiter', () => {
  it('allows `burst` back-to-back requests, then one per interval', () => {
    const limiter = new GcraLimiter({ burst: 3, ratePerSecond: 10 }); // interval = 100 ms
    expect(limiter.consume('a', { now: 0 })).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.consume('a', { now: 0 })).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('a', { now: 0 })).toMatchObject({ allowed: true, remaining: 0 });

    const denied = limiter.consume('a', { now: 0 });
    expect(denied).toMatchObject({ allowed: false, retryAfterMs: 100, resetMs: 300 });

    expect(limiter.consume('a', { now: 99 }).allowed).toBe(false);
    expect(limiter.consume('a', { now: 100 }).allowed).toBe(true);
  });

  it.each([
    { burst: 5, ratePerSecond: 10, seed: 1 },
    { burst: 1, ratePerSecond: 3, seed: 2 },
    { burst: 20, ratePerSecond: 7, seed: 3 },
    { burst: 100, ratePerSecond: 50, seed: 4 },
  ])(
    'makes the same decisions as a token bucket (burst=$burst, rate=$ratePerSecond/s)',
    ({ burst, ratePerSecond, seed }) => {
      const gcra = new GcraLimiter({ burst, ratePerSecond });
      const bucket = new TokenBucketLimiter({ capacity: burst, refillPerSecond: ratePerSecond });
      const random = mulberry32(seed);

      let t = 0;
      let allowedCount = 0;
      for (let i = 0; i < 20_000; i++) {
        // Mix of tight bursts (0 ms gaps) and pauses, in whole milliseconds.
        t += random() < 0.3 ? 0 : Math.floor(random() * (2000 / ratePerSecond));
        const a = gcra.consume('k', { now: t }).allowed;
        const b = bucket.consume('k', { now: t }).allowed;
        expect(a, `request #${i} at t=${t}`).toBe(b);
        if (a) allowedCount++;
      }
      // Sanity: the traffic actually exercised both outcomes.
      expect(allowedCount).toBeGreaterThan(0);
      expect(allowedCount).toBeLessThan(20_000);
    },
  );
});
