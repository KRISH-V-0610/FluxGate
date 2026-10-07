/**
 * Experiment 1: how accurate is each algorithm, and when does it break?
 *
 * The definition we hold every algorithm to: "never more than `limit`
 * requests admitted in ANY window of `windowMs`". The sliding window LOG
 * implements it exactly. For every other algorithm we replay the same
 * synthetic traffic and judge each decision against that limiter's OWN
 * admitted history:
 *   - wrong allow: it admitted a request although it had already admitted
 *                  `limit` in the last `windowMs` (over-admission)
 *   - wrong deny:  it rejected a request although fewer than `limit`
 *                  were admitted in the last `windowMs` (false denial)
 * (Comparing request-by-request with the log's decisions would be
 * misleading: under overload two limiters admit the same *number* of
 * requests but different *individual* ones.)
 *
 * Token bucket and GCRA are included for reference. They don't promise
 * this definition (they allow `capacity` extra as burst), and the peak
 * column shows by how much.
 *
 * Traffic patterns (one key, limit 100 / 60 s, 2 simulated hours each):
 *  - light:     Poisson arrivals at 0.5x the limit (most real clients, most of the time)
 *  - normal:    Poisson arrivals at 0.9x the limit (well-behaved client, Cloudflare's setting)
 *  - steady:    Poisson arrivals at 1.5x the limit (smooth overload)
 *  - bursty:    on/off traffic, quiet periods then 10x spikes (typical API clients)
 *  - adversarial: a client that knows the window edges and fires a full
 *               limit just before and just after each boundary
 *
 * No Redis needed; pure and deterministic (seeded PRNG).
 */
import {
  FixedWindowLimiter,
  GcraLimiter,
  SlidingWindowCounterLimiter,
  SlidingWindowLogLimiter,
  TokenBucketLimiter,
  type RateLimiter,
} from '@fluxgate/core';
import { exponential, maxInAnyWindow, mulberry32, writeResult } from './common.js';

const LIMIT = 100;
const WINDOW = 60_000;
const DURATION = 2 * 60 * 60 * 1000;

type Pattern = { name: string; description: string; times: number[] };

function poisson(seed: number, multiple: number): number[] {
  const random = mulberry32(seed);
  const rate = (multiple * LIMIT) / WINDOW;
  const times: number[] = [];
  for (let t = exponential(random, rate); t < DURATION; t += exponential(random, rate)) times.push(Math.floor(t));
  return times;
}

function bursty(seed: number): number[] {
  const random = mulberry32(seed);
  const times: number[] = [];
  let t = 0;
  let on = false;
  while (t < DURATION) {
    // ON phases ~10 s at 10x the limit's rate; OFF phases ~40 s at 0.2x.
    const phaseEnd = t + exponential(random, 1 / (on ? 10_000 : 40_000));
    const rate = ((on ? 10 : 0.2) * LIMIT) / WINDOW;
    for (t += exponential(random, rate); t < Math.min(phaseEnd, DURATION); t += exponential(random, rate)) {
      times.push(Math.floor(t));
    }
    t = phaseEnd;
    on = !on;
  }
  return times;
}

function adversarial(): number[] {
  const times: number[] = [];
  // Every other boundary: LIMIT requests in the last 500 ms of a window, LIMIT in the first 500 ms of the next.
  for (let boundary = WINDOW; boundary < DURATION; boundary += 2 * WINDOW) {
    for (let i = 0; i < LIMIT; i++) times.push(boundary - 500 + Math.floor((i * 500) / LIMIT));
    for (let i = 0; i < LIMIT; i++) times.push(boundary + Math.floor((i * 500) / LIMIT));
  }
  return times;
}

const algorithms: Record<string, () => RateLimiter> = {
  'sliding-log (exact)': () => new SlidingWindowLogLimiter({ limit: LIMIT, windowMs: WINDOW }),
  'fixed-window': () => new FixedWindowLimiter({ limit: LIMIT, windowMs: WINDOW }),
  'sliding-counter': () => new SlidingWindowCounterLimiter({ limit: LIMIT, windowMs: WINDOW }),
  'token-bucket': () => new TokenBucketLimiter({ capacity: LIMIT, refillPerSecond: LIMIT / (WINDOW / 1000) }),
  gcra: () => new GcraLimiter({ burst: LIMIT, ratePerSecond: LIMIT / (WINDOW / 1000) }),
};

const patterns: Pattern[] = [
  { name: 'light', description: 'Poisson, 0.5x the limit', times: poisson(3, 0.5) },
  { name: 'normal', description: 'Poisson, 0.9x the limit', times: poisson(1, 0.9) },
  { name: 'steady', description: 'Poisson, 1.5x the limit', times: poisson(42, 1.5) },
  { name: 'bursty', description: 'on/off, 10x spikes', times: bursty(7) },
  { name: 'adversarial', description: 'full limit on both sides of every boundary', times: adversarial() },
];

const rows = [];
for (const pattern of patterns) {
  for (const [name, make] of Object.entries(algorithms)) {
    const limiter = make();
    const admitted: number[] = [];
    let oldest = 0; // index of the first admitted timestamp still inside the window
    let wrongAllow = 0;
    let wrongDeny = 0;
    for (const t of pattern.times) {
      while (oldest < admitted.length && admitted[oldest]! <= t - WINDOW) oldest++;
      const shouldAllow = admitted.length - oldest < LIMIT;
      const allowed = limiter.consume('k', t).allowed;
      if (allowed) admitted.push(t);
      if (allowed && !shouldAllow) wrongAllow++;
      if (!allowed && shouldAllow) wrongDeny++;
    }
    const peak = maxInAnyWindow(admitted, WINDOW);
    const pct = (n: number) => Math.round((n / pattern.times.length) * 100_000) / 1000;
    rows.push({
      pattern: pattern.name,
      algorithm: name,
      requests: pattern.times.length,
      admitted: admitted.length,
      peakInAnyWindow: peak,
      peakOverLimit: Math.round((peak / LIMIT) * 100) / 100,
      wrongAllowPct: pct(wrongAllow),
      wrongDenyPct: pct(wrongDeny),
    });
  }
}

console.table(rows);
writeResult('accuracy', {
  setup: { limit: LIMIT, windowMs: WINDOW, durationMs: DURATION, patterns: patterns.map(({ name, description }) => ({ name, description })) },
  rows,
});
