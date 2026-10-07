import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createCheck, type CheckOptions, type Decision } from './check.js';

export interface ExpressOptions extends CheckOptions<Request> {
  /** Who is this request from? Default: the `x-api-key` header, else the client IP. */
  key?: (req: Request) => string;
  /** Units this request uses, e.g. tokens in an LLM prompt. Default 1. */
  cost?: (req: Request) => number | Promise<number>;
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

/**
 * Express middleware (4 and 5).
 *
 *     app.use('/api', fluxgate({ limiter }));
 *     app.post('/v1/chat', express.json(), fluxgate({ limiter, cost: (req) => req.body.maxTokens }), chat);
 */
export function fluxgate(options: ExpressOptions): RequestHandler {
  const check = createCheck(options);
  const keyOf = options.key ?? defaultKey;

  return async (req: Request, res: Response, next: NextFunction) => {
    let decision: Decision;
    try {
      decision = await check(keyOf(req), { cost: await options.cost?.(req), context: req });
    } catch (err) {
      // A bug in key/cost, not a limiter outage: let Express's error handler see it.
      return next(err);
    }
    res.set(decision.headers);
    if (decision.allowed) return next();
    res.status(decision.rejection.status).json(decision.rejection.body);
  };
}
