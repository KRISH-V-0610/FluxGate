import type { Context, MiddlewareHandler } from 'hono';
import { createCheck, type CheckOptions } from './check.js';

export interface HonoOptions extends CheckOptions<Context> {
  /**
   * Who is this request from? Required, because Hono runs on Node, Bun, Deno,
   * Cloudflare Workers and more, and each exposes the client IP differently
   * (see hono's getConnInfo). An API key header works everywhere.
   */
  key: (c: Context) => string;
  /** Units this request uses. Default 1. */
  cost?: (c: Context) => number | Promise<number>;
}

/**
 * Hono middleware.
 *
 *     app.use('/api/*', fluxgate({ limiter, key: (c) => c.req.header('x-api-key') ?? 'anonymous' }));
 */
export function fluxgate(options: HonoOptions): MiddlewareHandler {
  const check = createCheck(options);

  return async (c, next) => {
    const decision = await check(options.key(c), { cost: await options.cost?.(c), context: c });
    if (!decision.allowed) return c.json(decision.rejection.body, decision.rejection.status, decision.headers);
    await next();
    // Set after next(): headers set before it are dropped when a handler returns a plain Response.
    for (const [name, value] of Object.entries(decision.headers)) c.header(name, value);
  };
}
