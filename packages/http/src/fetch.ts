import { createCheck, type CheckOptions, type Decision } from './check.js';

/**
 * For anything built on the Fetch API's Request and Response: Next.js route
 * handlers and middleware, Bun.serve, Deno.serve, Cloudflare Workers.
 */
export interface FetchOptions<Req extends Request = Request> extends CheckOptions<Req> {
  /**
   * Who is this request from? Required: there's no portable way to read the
   * client IP from a Request (Next.js, Bun and Workers each have their own).
   */
  key: (req: Req) => string;
  /** Units this request uses. Default 1. */
  cost?: (req: Req) => number | Promise<number>;
}

/**
 * The decision for one Request, when you want to handle the answer yourself,
 * e.g. in Next.js middleware:
 *
 *     const limit = checkRequest({ limiter, key: (req) => req.headers.get('x-api-key') ?? 'anonymous' });
 *     export async function middleware(req: NextRequest) {
 *       const decision = await limit(req);
 *       if (!decision.allowed) return rejectionResponse(decision);
 *       return NextResponse.next({ headers: decision.headers });
 *     }
 */
export function checkRequest<Req extends Request = Request>(options: FetchOptions<Req>): (req: Req) => Promise<Decision> {
  const check = createCheck(options);
  return async (req) => check(options.key(req), { cost: await options.cost?.(req), context: req });
}

/** The 413, 429 or 503 response for a request that may not go ahead. */
export function rejectionResponse(decision: Extract<Decision, { allowed: false }>): Response {
  return Response.json(decision.rejection.body, { status: decision.rejection.status, headers: decision.headers });
}

/**
 * Wraps a fetch-style handler, e.g. a Next.js route handler:
 *
 *     export const POST = withRateLimit({ limiter, key, cost: countTokens }, async (req) => {
 *       return Response.json(await answer(req));
 *     });
 *
 * Extra arguments (Next.js's `{ params }`, a Worker's `env`) are passed through.
 */
export function withRateLimit<Req extends Request, Args extends unknown[]>(
  options: FetchOptions<Req>,
  handler: (req: Req, ...args: Args) => Response | Promise<Response>,
): (req: Req, ...args: Args) => Promise<Response> {
  const limit = checkRequest(options);
  return async (req, ...args) => {
    const decision = await limit(req);
    if (!decision.allowed) return rejectionResponse(decision);
    return withHeaders(await handler(req, ...args), decision.headers);
  };
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    // Responses from fetch() or Response.redirect() have read-only headers: copy, then set.
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}
