import type { FastifyReply, FastifyRequest } from 'fastify';
import { createCheck, type CheckOptions } from './check.js';

export interface FastifyOptions extends CheckOptions<FastifyRequest> {
  /** Who is this request from? Default: the `x-api-key` header, else the client IP. */
  key?: (req: FastifyRequest) => string;
  /** Units this request uses. Default 1. Needs the parsed body? Register as preHandler, not onRequest. */
  cost?: (req: FastifyRequest) => number | Promise<number>;
}

const MAX_KEY_LENGTH = 128;

/** Same rule as the Express adapter: API key if present, otherwise IP. */
export function defaultKey(req: FastifyRequest): string {
  const header = req.headers['x-api-key'];
  const apiKey = Array.isArray(header) ? header[0] : header;
  if (apiKey) return `key:${apiKey.slice(0, MAX_KEY_LENGTH)}`;
  return `ip:${req.ip}`;
}

/**
 * A Fastify hook (4 and 5), for the whole app or one route:
 *
 *     app.addHook('onRequest', fluxgate({ limiter }));
 *     app.post('/v1/chat', { preHandler: fluxgate({ limiter, cost: (req) => req.body.maxTokens }) }, chat);
 */
export function fluxgate(options: FastifyOptions): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const check = createCheck(options);
  const keyOf = options.key ?? defaultKey;

  return async (req, reply) => {
    const decision = await check(keyOf(req), { cost: await options.cost?.(req), context: req });
    reply.headers(decision.headers);
    // In an async hook, sending a reply is what stops the request; returning normally lets it through.
    if (!decision.allowed) await reply.code(decision.rejection.status).send(decision.rejection.body);
  };
}
