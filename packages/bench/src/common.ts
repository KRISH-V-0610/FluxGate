import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from packages/bench/dist/ (or src/). */
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../../../results/', import.meta.url));

export function writeResult(name: string, data: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = `${RESULTS_DIR}${name}.json`;
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...(data as object) }, null, 2)}\n`);
  console.log(`→ wrote results/${name}.json`);
}

/** Seeded PRNG (mulberry32), so every run produces the same synthetic traffic. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential inter-arrival time (ms) for a Poisson process at `ratePerMs`. */
export function exponential(random: () => number, ratePerMs: number): number {
  return -Math.log(1 - random()) / ratePerMs;
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function latencySummary(ms: number[]) {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    samples: ms.length,
    p50: round(percentile(ms, 50)),
    p90: round(percentile(ms, 90)),
    p99: round(percentile(ms, 99)),
    max: round(Math.max(...ms)),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Open-loop load: fire requests at Poisson arrival times regardless of how
 * long earlier ones take, like real independent users. A closed loop
 * ("wait for the response, then send the next") hides latency problems,
 * because a slow server automatically receives less load.
 */
export async function openLoop(
  ratePerSecond: number,
  durationMs: number,
  random: () => number,
  fire: (elapsedMs: number) => void,
): Promise<void> {
  const start = performance.now();
  let next = 0;
  for (;;) {
    const elapsed = performance.now() - start;
    if (elapsed >= durationMs) return;
    while (next <= elapsed) {
      fire(next);
      next += exponential(random, ratePerSecond / 1000);
    }
    await sleep(1);
  }
}

/** Run a docker compose command without blocking the event loop (it would distort latency). */
export function docker(args: string): Promise<boolean> {
  return new Promise((resolve) => exec(`docker compose ${args}`, { cwd: ROOT }, (error) => resolve(error === null)));
}

/** Largest number of timestamps inside any window of `windowMs` (two pointers, O(n)). */
export function maxInAnyWindow(sortedTimes: number[], windowMs: number): number {
  let best = 0;
  let left = 0;
  for (let right = 0; right < sortedTimes.length; right++) {
    while (sortedTimes[right]! - sortedTimes[left]! >= windowMs) left++;
    best = Math.max(best, right - left + 1);
  }
  return best;
}
