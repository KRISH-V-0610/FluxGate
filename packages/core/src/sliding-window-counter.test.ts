import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './fixed-window.js';
import { SlidingWindowCounterLimiter } from './sliding-window-counter.js';
import { SlidingWindowLogLimiter } from './sliding-window-log.js';

const MINUTE = 60_000;

describe('SlidingWindowCounterLimiter', () => {
  it("reproduces Cloudflare's worked example: 42 * 0.75 + 18 = 49.5 < 50", () => {
    const limiter = new SlidingWindowCounterLimiter({ limit: 50, windowMs: MINUTE });

    // Previous minute: 42 requests.
    for (let i = 0; i < 42; i++) expect(limiter.consume('k', i * 1000).allowed).toBe(true);
    // Current minute: 18 requests, all before the 15 s mark.
    for (let i = 0; i < 18; i++) expect(limiter.consume('k', MINUTE + 14_000).allowed).toBe(true);

    // 15 s into the minute the previous window still overlaps by 45/60 = 0.75.
    // estimate = 42 * 0.75 + 18 = 49.5, below 50, so this one is allowed...
    const allowed = limiter.consume('k', MINUTE + 15_000);
    expect(allowed).toMatchObject({ allowed: true, remaining: 0 });

    // ...and the next is not: 42 * 0.75 + 19 = 50.5.
    const denied = limiter.consume('k', MINUTE + 15_000);
    expect(denied.allowed).toBe(false);

    // retryAfterMs is exact: one ms earlier is still denied, at retryAfterMs it is allowed.
    const retryAt = MINUTE + 15_000 + denied.retryAfterMs!;
    expect(limiter.consume('k', retryAt - 1).allowed).toBe(false);
    expect(limiter.consume('k', retryAt).allowed).toBe(true);
  });

  it('softens the boundary burst: fixed window allows 6, counter 4, exact log 3', () => {
    const times = [997, 998, 999, 1000, 1001, 1002];
    const count = (l: { consume(k: string, t: number): { allowed: boolean } }) =>
      times.filter((t) => l.consume('a', t).allowed).length;

    expect(count(new FixedWindowLimiter({ limit: 3, windowMs: 1000 }))).toBe(6);
    // At t=1001 the previous window weighs 999/1000: 3 * 0.999 = 2.997 < 3, so one slips in.
    expect(count(new SlidingWindowCounterLimiter({ limit: 3, windowMs: 1000 }))).toBe(4);
    expect(count(new SlidingWindowLogLimiter({ limit: 3, windowMs: 1000 }))).toBe(3);
  });

  describe('FAILURE MODE: the "evenly spread" assumption', () => {
    // Both cases put 10 requests in window 0 (limit 10 per 1000 ms) and then
    // ask at t=1500. The counter can't tell *when* in window 0 those
    // requests happened; it always weighs them by 0.5.
    const ask = (previousTimes: number[]) => {
      const counter = new SlidingWindowCounterLimiter({ limit: 10, windowMs: 1000 });
      const exact = new SlidingWindowLogLimiter({ limit: 10, windowMs: 1000 });
      for (const t of previousTimes) {
        counter.consume('a', t);
        exact.consume('a', t);
      }
      let counterAllowed = 0;
      let exactAllowed = 0;
      for (let i = 0; i < 20; i++) {
        if (counter.consume('a', 1500).allowed) counterAllowed++;
        if (exact.consume('a', 1500).allowed) exactAllowed++;
      }
      return { counterAllowed, exactAllowed };
    };

    it('under-admits when the previous window was front-loaded (false denials)', () => {
      const early = Array.from({ length: 10 }, (_, i) => i); // t = 0..9
      // In (500, 1500] there are really zero requests, so 10 are allowed. The counter estimates 5.
      expect(ask(early)).toEqual({ counterAllowed: 5, exactAllowed: 10 });
    });

    it('over-admits when the previous window was back-loaded', () => {
      const late = Array.from({ length: 10 }, (_, i) => 990 + i); // t = 990..999
      // In (500, 1500] there are really 10 requests already, so 0 are allowed. The counter allows 5.
      expect(ask(late)).toEqual({ counterAllowed: 5, exactAllowed: 0 });
    });
  });

  it('forgets everything after two idle windows', () => {
    const limiter = new SlidingWindowCounterLimiter({ limit: 2, windowMs: 1000 });
    limiter.consume('a', 0);
    limiter.consume('a', 0);
    expect(limiter.consume('a', 1).allowed).toBe(false);
    expect(limiter.consume('a', 2000)).toMatchObject({ allowed: true, remaining: 1 });
  });
});
