import { resolveCost, type AnyRateLimiter, type RateLimitResult } from '@fluxgate/core';
import type { Metrics } from './metrics.js';

/**
 * What to do when the limiter itself is broken (Redis down, timeout, bug):
 *  - 'open'   → let the request through. Availability over protection.
 *               Right for most APIs: a dead limiter shouldn't become an outage.
 *  - 'closed' → reject with 503. Protection over availability.
 *               Right when the limit guards something expensive or dangerous
 *               (login attempts, SMS sending, paid third-party APIs).
 */
export type FailMode = 'open' | 'closed';

/**
 * What happened, in one word. Also the `outcome` label in the metrics.
 *  - allowed      the limiter said yes
 *  - denied       the limiter said no
 *  - degraded     the limiter failed and the request was let through (fail-open)
 *  - unavailable  the limiter failed and the request was blocked (fail-closed)
 */
export type Outcome = 'allowed' | 'denied' | 'degraded' | 'unavailable';

export interface CheckOptions<Context = undefined> {
  /**
   * One limiter for everyone, or a function that picks one per caller, e.g.
   * by plan (see byTier) or by route. `context` is whatever the adapter
   * passes: the framework's request object.
   */
  limiter: AnyRateLimiter | ((key: string, context: Context) => AnyRateLimiter);
  /** Default 'open'. */
  failMode?: FailMode;
  /** Treat a limiter slower than this as failed. Default 200 ms. */
  timeoutMs?: number;
  /** Called when the limiter throws or times out: the place for logging and alerts. */
  onError?: (err: unknown, key: string, context: Context) => void;
  /** Record every decision in this registry (served on /metrics). */
  metrics?: Metrics;
  /** The `limiter` label in metrics, e.g. 'api' or 'login'. Default 'default'. */
  name?: string;
}

/** The HTTP answer for a request that may not go ahead. */
export interface Rejection {
  status: 413 | 429 | 503;
  body: Record<string, unknown>;
}

interface DecisionBase {
  /** The limiter's answer. Absent when the limiter failed. */
  result?: RateLimitResult;
  /** Headers to send with the response, whether it's allowed or not. */
  headers: Record<string, string>;
  /** Why the limiter failed, when outcome is degraded or unavailable. */
  error?: unknown;
}

/** Everything an adapter needs: go ahead or not, which headers, and what to answer if not. */
export type Decision =
  | (DecisionBase & { allowed: true; outcome: 'allowed' | 'degraded' })
  | (DecisionBase & { allowed: false; outcome: 'denied' | 'unavailable'; rejection: Rejection });

export interface CheckRequest<Context> {
  /** Units this request uses. Default 1 (see ConsumeOptions.cost in @fluxgate/core). */
  cost?: number;
  /** Passed to `limiter` when it's a function, and to `onError`. */
  context?: Context;
}

export type Check<Context = undefined> = (key: string, request?: CheckRequest<Context>) => Promise<Decision>;

/**
 * The framework-agnostic core of every adapter: ask the limiter, survive its
 * failures, record metrics, and turn the answer into HTTP terms.
 *
 * Use it directly anywhere that isn't an HTTP framework: a queue worker, a
 * WebSocket server, a CLI, a cron job.
 *
 *     const check = createCheck({ limiter });
 *     const decision = await check(`user:${id}`, { cost: tokens });
 *     if (!decision.allowed) ...
 */
export function createCheck<Context = undefined>(options: CheckOptions<Context>): Check<Context> {
  const failMode = options.failMode ?? 'open';
  const timeoutMs = options.timeoutMs ?? 200;
  const name = options.name ?? 'default';
  const pick = typeof options.limiter === 'function' ? options.limiter : () => options.limiter as AnyRateLimiter;
  options.metrics?.declare(name);

  return async (key, request = {}) => {
    // A bad cost is a bug in the caller, not a limiter failure, so it throws
    // here instead of being swallowed by fail-open.
    const cost = resolveCost(request.cost);
    const context = request.context as Context;
    const started = performance.now();

    let result: RateLimitResult;
    try {
      const pending = pick(key, context).consume(key, { cost });
      // In-memory limiters answer synchronously and can't hang: skip the timer.
      result = pending instanceof Promise ? await withTimeout(pending, timeoutMs) : pending;
    } catch (error) {
      options.onError?.(error, key, context);
      const decision = failed(failMode, error);
      options.metrics?.record(name, decision.outcome, (performance.now() - started) / 1000, cost);
      return decision;
    }

    const decision = decide(result, cost);
    options.metrics?.record(name, decision.outcome, (performance.now() - started) / 1000, cost);
    return decision;
  };
}

/** Races the limiter against a timer, because a hanging limiter is worse than a failing one. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`rate limiter timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Standard headers so well-behaved clients can slow down by themselves:
 *   X-RateLimit-Limit      the maximum
 *   X-RateLimit-Remaining  how many are left right now
 *   X-RateLimit-Reset      seconds until fully reset (delta seconds, as in the IETF
 *                          RateLimit-header draft; GitHub uses an epoch timestamp instead)
 *   Retry-After            on 429 only: seconds to wait (HTTP standard, RFC 9110)
 */
function decide(result: RateLimitResult, cost: number): Decision {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetMs / 1000)),
  };
  if (result.allowed) return { allowed: true, outcome: 'allowed', result, headers };

  if (result.retryAfterMs === undefined) {
    // The cost is bigger than the whole limit, so waiting can never help.
    // Not a 429: clients and SDKs retry 429s automatically, forever.
    return {
      allowed: false,
      outcome: 'denied',
      result,
      headers,
      rejection: { status: 413, body: { error: 'cost_exceeds_limit', cost, limit: result.limit } },
    };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  headers['Retry-After'] = String(retryAfterSeconds);
  return {
    allowed: false,
    outcome: 'denied',
    result,
    headers,
    rejection: { status: 429, body: { error: 'rate_limited', retryAfterSeconds } },
  };
}

function failed(failMode: FailMode, error: unknown): Decision {
  // Either way, tell the client the answer didn't come from a working limiter.
  const headers = { 'X-RateLimit-Status': 'degraded' };
  if (failMode === 'open') return { allowed: true, outcome: 'degraded', headers, error };
  return {
    allowed: false,
    outcome: 'unavailable',
    headers,
    error,
    rejection: { status: 503, body: { error: 'rate_limiter_unavailable' } },
  };
}
