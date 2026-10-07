import type { AsyncRateLimiter, ConsumeOptions, RateLimitResult } from '@fluxgate/core';

export interface FluxgateClientOptions {
  /** Where the FluxGate service runs, e.g. http://ratelimit:3000 */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. Needed when the service sets SERVICE_TOKEN. */
  token?: string;
  /**
   * Give up after this long. Default 100 ms: a rate-limit check sits in front
   * of every request, so a slow answer is treated like no answer (the
   * caller's fail mode decides what happens next).
   */
  timeoutMs?: number;
  /** Custom fetch, e.g. a Cloudflare service binding or a test stub. Default: the global fetch. */
  fetch?: typeof fetch;
}

export interface ServiceCheck {
  /** Which of the service's policies to apply, e.g. 'free' or 'login'. */
  policy: string;
  /** Who is asking, e.g. 'user:42' or 'ip:203.0.113.7'. */
  key: string;
  /** Units this request uses. Default 1. */
  cost?: number;
}

/**
 * The service didn't give a decision: network error, timeout, 5xx (its
 * store is down), or a 4xx because the request was wrong (unknown policy,
 * bad token). Thrown, so the adapters' fail-open / fail-closed applies.
 */
export class FluxgateServiceError extends Error {
  override readonly name = 'FluxgateServiceError';
  constructor(
    message: string,
    /** HTTP status, when the service answered at all. */
    readonly status?: number,
    /** The service's error body, when it sent one. */
    readonly body?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Talks to a FluxGate service (`POST /v1/check`) instead of to Redis.
 * Use it when the rate-limit rules should live in one place for many apps
 * and languages, or from runtimes that can't open a Redis connection
 * (edge functions, serverless). The same pattern as Envoy's rate-limit service.
 *
 *     const client = new FluxgateClient({ url: 'http://ratelimit:3000', token });
 *     app.use(fluxgate({ limiter: client.policy('free') }));      // any @fluxgate/http adapter
 *     const result = await client.check({ policy: 'login', key: `ip:${ip}` });
 */
export class FluxgateClient {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: FluxgateClientOptions) {
    this.endpoint = new URL('v1/check', options.url.endsWith('/') ? options.url : `${options.url}/`).href;
    this.headers = { 'content-type': 'application/json' };
    if (options.token) this.headers.authorization = `Bearer ${options.token}`;
    this.timeoutMs = options.timeoutMs ?? 100;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** One decision. Resolves with the result (allowed or denied); throws when there's no decision. */
  async check(request: ServiceCheck): Promise<RateLimitResult> {
    let res: Response;
    try {
      res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new FluxgateServiceError(
        timedOut ? `rate-limit service timed out after ${this.timeoutMs} ms` : `rate-limit service unreachable: ${String(err)}`,
        undefined,
        undefined,
        { cause: err },
      );
    }

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const code = isRecord(body) && typeof body.error === 'string' ? ` (${body.error})` : '';
      throw new FluxgateServiceError(`rate-limit service answered ${res.status}${code}`, res.status, body);
    }
    if (!isResult(body)) throw new FluxgateServiceError('rate-limit service sent an invalid decision', res.status, body);
    return body;
  }

  /** A limiter backed by one of the service's policies, to pass to any @fluxgate/http adapter. */
  policy(name: string): AsyncRateLimiter {
    return { consume: (key: string, options: ConsumeOptions = {}) => this.check({ policy: name, key, cost: options.cost }) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResult(value: unknown): value is RateLimitResult {
  return (
    isRecord(value) &&
    typeof value.allowed === 'boolean' &&
    typeof value.limit === 'number' &&
    typeof value.remaining === 'number' &&
    typeof value.resetMs === 'number' &&
    (value.retryAfterMs === undefined || typeof value.retryAfterMs === 'number')
  );
}
