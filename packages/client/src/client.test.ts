import { describe, expect, it } from 'vitest';
import { FluxgateClient, FluxgateServiceError } from './index.js';

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records what was sent and answers with a fixed response. */
function stub(answer: () => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return answer();
  };
  return { fetch: fake as typeof fetch, sent };
}

const decision = { allowed: true, limit: 20, remaining: 19, resetMs: 500 };

describe('FluxgateClient', () => {
  it('POSTs the policy, key and cost to /v1/check with the bearer token', async () => {
    const { fetch, sent } = stub(() => Response.json(decision));
    const client = new FluxgateClient({ url: 'http://ratelimit:3000', token: 's3cret', fetch });
    expect(await client.check({ policy: 'free', key: 'user:42', cost: 3 })).toEqual(decision);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('http://ratelimit:3000/v1/check');
    expect(sent[0]!.init.method).toBe('POST');
    expect(sent[0]!.init.headers).toMatchObject({ authorization: 'Bearer s3cret', 'content-type': 'application/json' });
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ policy: 'free', key: 'user:42', cost: 3 });
  });

  it('keeps a path prefix in the base URL', async () => {
    const { fetch, sent } = stub(() => Response.json(decision));
    await new FluxgateClient({ url: 'https://gateway.example/ratelimit/', fetch }).check({ policy: 'p', key: 'k' });
    expect(sent[0]!.url).toBe('https://gateway.example/ratelimit/v1/check');
  });

  it('returns a denial as a result, not an error', async () => {
    const denied = { allowed: false, limit: 20, remaining: 0, resetMs: 9000, retryAfterMs: 450 };
    const { fetch } = stub(() => Response.json(denied));
    expect(await new FluxgateClient({ url: 'http://x', fetch }).check({ policy: 'p', key: 'k' })).toEqual(denied);
  });

  it('throws FluxgateServiceError with the status when the service has no decision (503, 401, 400)', async () => {
    for (const [status, error] of [
      [503, 'rate_limiter_unavailable'],
      [401, 'unauthorized'],
      [400, 'unknown_policy'],
    ] as const) {
      const { fetch } = stub(() => Response.json({ error }, { status }));
      const failure = new FluxgateClient({ url: 'http://x', fetch }).check({ policy: 'p', key: 'k' });
      await expect(failure).rejects.toBeInstanceOf(FluxgateServiceError);
      await expect(failure).rejects.toMatchObject({ status, message: `rate-limit service answered ${status} (${error})` });
    }
  });

  it('times out instead of waiting for a slow service', async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const started = performance.now();
    const failure = new FluxgateClient({ url: 'http://x', timeoutMs: 30, fetch: slow }).check({ policy: 'p', key: 'k' });
    await expect(failure).rejects.toThrow('rate-limit service timed out after 30 ms');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('wraps network errors, and rejects answers that are not a decision', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(new FluxgateClient({ url: 'http://x', fetch: down }).check({ policy: 'p', key: 'k' })).rejects.toThrow(
      /unreachable: TypeError: fetch failed/,
    );
    const { fetch } = stub(() => Response.json({ hello: 'world' }));
    await expect(new FluxgateClient({ url: 'http://x', fetch }).check({ policy: 'p', key: 'k' })).rejects.toThrow(
      'invalid decision',
    );
  });

  it('policy() is an AsyncRateLimiter, so it plugs into any adapter', async () => {
    const { fetch, sent } = stub(() => Response.json(decision));
    const limiter = new FluxgateClient({ url: 'http://x', fetch }).policy('pro');
    expect(await limiter.consume('user:7', { cost: 5 })).toEqual(decision);
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({ policy: 'pro', key: 'user:7', cost: 5 });
  });
});
