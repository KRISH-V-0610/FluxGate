import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AnyRateLimiter, RateLimitResult } from '@fluxgate/core';

/**
 * What to do when the limiter itself is broken (Redis down, timeout, bug):
 *  - 'open'   → let the request through. Availability over protection.
 *               Right for most APIs: a dead limiter shouldn't become an outage.
 *  - 'closed' → reject with 503. Protection over availability.
 *               Right when the limit guards something expensive or dangerous
 *               (login attempts, SMS sending, paid third-party APIs).
 */
export type FailMode = 'open' | 'closed';

export interface FluxgateOptions {
  /** One limiter for everyone, or a function picking one per request (e.g. tiers). */
  limiter: AnyRateLimiter | ((req: Request, key: string) => AnyRateLimiter);
  /** Who is this request from? Default: the `x-api-key` header, else the client IP. */
  key?: (req: Request) => string;
  /** Default 'open'. */
  failMode?: FailMode;
  /** Treat a limiter slower than this as failed. Default 200 ms. */
  timeoutMs?: number;
  /** Hook for logging/metrics when the limiter fails. */
  onError?: (err: unknown, req: Request) => void;
}

const MAX_KEY_LENGTH = 128;

/**
 * Default identity: API key if present, otherwise IP. Prefixed so an API
 * key can never collide with an IP, and length-capped so a client can't
 * make us store megabyte-sized keys in Redis.
 */
export function defaultKey(req: Request): string {
  const apiKey = req.get('x-api-key');
  if (apiKey) return `key:${apiKey.slice(0, MAX_KEY_LENGTH)}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

/** Races the limiter against a timer, because a hanging limiter is worse than a failing one. */
async function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
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
function setHeaders(res: Response, r: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', String(r.limit));
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
}

export function fluxgate(options: FluxgateOptions): RequestHandler {
  const keyOf = options.key ?? defaultKey;
  const failMode = options.failMode ?? 'open';
  const timeoutMs = options.timeoutMs ?? 200;
  const pick = typeof options.limiter === 'function' ? options.limiter : () => options.limiter as AnyRateLimiter;

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);

    let result: RateLimitResult;
    try {
      // `await` works for both sync (in-memory) and async (Redis) limiters.
      result = await withTimeout(pick(req, key).consume(key), timeoutMs);
    } catch (err) {
      options.onError?.(err, req);
      res.setHeader('X-RateLimit-Status', 'degraded');
      if (failMode === 'open') return next();
      res.status(503).json({ error: 'rate_limiter_unavailable' });
      return;
    }

    setHeaders(res, result);
    if (result.allowed) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited', retryAfterSeconds });
  };
}
