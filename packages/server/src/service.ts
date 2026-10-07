import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from 'express';
import type { AnyRateLimiter } from '@fluxgate/core';
import { createCheck, type Check, type Metrics } from '@fluxgate/http';

export interface ServiceOptions {
  /** Policy name → its limiter. Callers pick one by name. */
  policies: Record<string, AnyRateLimiter>;
  /** When set, callers must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Treat a store slower than this as down. Default 200 ms. */
  timeoutMs?: number;
  /** Record each decision under the policy's name. */
  metrics?: Metrics;
  onError?: (err: unknown, policy: string) => void;
}

const MAX_KEY_LENGTH = 256;

/**
 * Rate limiting as a service: other apps ask over HTTP instead of talking
 * to Redis themselves (the pattern of Envoy's rate-limit service).
 *
 *   POST /v1/check   {"policy": "free", "key": "user:42", "cost": 1}
 *
 *   200  the decision: {allowed, limit, remaining, resetMs, retryAfterMs?}.
 *        A denial is still a 200: the check worked, the answer is "no".
 *   400  the request is wrong (unknown policy, bad key or cost)
 *   401  missing or wrong token
 *   503  the store is down. The service never guesses: the caller's own
 *        fail mode (in @fluxgate/client + an adapter) decides what to do.
 */
export function createServiceRouter(options: ServiceOptions): Router {
  const checks = new Map<string, Check>();
  for (const [name, limiter] of Object.entries(options.policies)) {
    checks.set(
      name,
      createCheck({
        limiter,
        name,
        failMode: 'closed',
        timeoutMs: options.timeoutMs,
        metrics: options.metrics,
        onError: (err) => options.onError?.(err, name),
      }),
    );
  }

  const router = express.Router();
  router.post('/v1/check', authorize(options.token), express.json({ limit: '4kb' }), async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null) {
      return void res.status(400).json({ error: 'invalid_request', message: 'send a JSON object: {"policy", "key", "cost"?}' });
    }
    const { policy, key, cost } = body as Record<string, unknown>;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      return void res.status(400).json({ error: 'invalid_request', message: `key must be a string of 1-${MAX_KEY_LENGTH} characters` });
    }
    if (cost !== undefined && (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 1)) {
      return void res.status(400).json({ error: 'invalid_request', message: 'cost must be a positive whole number' });
    }
    const check = typeof policy === 'string' ? checks.get(policy) : undefined;
    if (check === undefined) {
      return void res.status(400).json({ error: 'unknown_policy', policy, policies: [...checks.keys()] });
    }

    const decision = await check(key, { cost });
    if (decision.outcome === 'unavailable') return void res.status(503).json(decision.rejection.body);
    res.json(decision.result);
  });

  // Malformed or oversized JSON from express.json(): answer in the same JSON shape.
  const invalidBody: ErrorRequestHandler = (err: { status?: number; message?: string }, _req, res, next) => {
    if (typeof err.status !== 'number' || err.status >= 500) return next(err);
    res.status(err.status).json({ error: 'invalid_request', message: err.message });
  };
  router.use('/v1/check', invalidBody);
  return router;
}

/**
 * Bearer-token check. Both sides are hashed first so the comparison is
 * constant-time and the same length (timingSafeEqual needs that), which
 * means response timing leaks nothing about the token, not even its length.
 */
function authorize(token: string | undefined): RequestHandler {
  if (!token) return (_req, _res, next) => next();
  const expected = sha256(token);
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (timingSafeEqual(sha256(given), expected)) return next();
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
