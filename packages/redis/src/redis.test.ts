import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { TokenBucketLimiter } from '@fluxgate/core';
import { connectRedis } from './client.js';
import { LeasedTokenBucket } from './leased-token-bucket.js';
import { NaiveRedisTokenBucket } from './naive-token-bucket.js';
import { RedisTokenBucket } from './redis-token-bucket.js';
import { takeTokens } from './token-bucket-script.js';

/**
 * Integration tests against a real Redis (`docker compose up -d redis`).
 * They're skipped, not failed, when no Redis is reachable, so `npm test`
 * still works on a laptop without Docker.
 */
async function tryConnect(): Promise<Redis | undefined> {
  try {
    return await connectRedis({ commandTimeoutMs: 2000 });
  } catch {
    return undefined;
  }
}

const redis = await tryConnect();
// A fresh namespace per run, so reruns never see each other's buckets.
const ns = `test:${randomUUID()}:`;

/** Fire `n` requests at once, like n clients hitting n app instances at the same moment. */
async function burst(limiter: { consume(key: string): Promise<{ allowed: boolean }> }, key: string, n: number) {
  const results = await Promise.all(Array.from({ length: n }, () => limiter.consume(key)));
  return results.filter((r) => r.allowed).length;
}

describe.skipIf(redis === undefined)('Redis limiters (integration)', () => {
  let r: Redis;
  beforeAll(() => {
    r = redis!;
  });
  afterAll(async () => {
    const keys = await r.keys(`${ns}*`);
    if (keys.length > 0) await r.del(...keys);
    r.disconnect();
  });

  // Capacity 10, refill so slow it can't matter during the test.
  const config = { capacity: 10, refillPerSecond: 0.001 };

  it('BROKEN: the naive GET-then-SET limiter over-admits under concurrency', async () => {
    const naive = new NaiveRedisTokenBucket(r, { ...config, prefix: `${ns}naive:` });
    const allowed = await burst(naive, 'user', 200);
    // All 200 reads happen before any write lands, so every request sees a full bucket.
    expect(allowed).toBeGreaterThan(10);
  });

  it('FIXED: the Lua limiter admits exactly the capacity under the same load', async () => {
    const atomic = new RedisTokenBucket(r, { ...config, prefix: `${ns}lua:` });
    expect(await burst(atomic, 'user', 200)).toBe(10);
  });

  it('shares one global limit across many app instances', async () => {
    // Three limiter objects ≈ three app servers; they share only Redis.
    const instances = [1, 2, 3].map(() => new RedisTokenBucket(r, { ...config, prefix: `${ns}global:` }));
    const counts = await Promise.all(instances.map((l) => burst(l, 'user', 50)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('the Lua script makes the same decisions as the in-memory token bucket', async () => {
    const tb = { capacity: 5, refillPerSecond: 4 };
    const memory = new TokenBucketLimiter(tb);
    const key = `${ns}equiv`;
    // Deterministic timestamps passed in through ARGV[4].
    const times = [0, 0, 0, 0, 0, 0, 100, 250, 251, 500, 1000, 1001, 1002, 1003, 5000, 5000, 5000, 5000, 5000, 5000, 5001];
    for (const t of times) {
      const lua = await takeTokens(r, key, tb, 1, 1_000_000 + t);
      const mem = memory.consume('k', 1_000_000 + t);
      expect(lua.granted === 1, `t=${t}`).toBe(mem.allowed);
      expect(lua.remaining, `t=${t}`).toBe(mem.remaining);
    }
  });

  it('expires the key once the bucket would be full again (absent == full)', async () => {
    const key = `${ns}ttl`;
    await takeTokens(r, key, { capacity: 2, refillPerSecond: 10 }, 1);
    const ttl = await r.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100); // 1 token at 10/s = 100 ms
  });

  it('leasing never admits more than capacity in a single burst, using far fewer Redis calls', async () => {
    const leased = new LeasedTokenBucket(r, { ...config, prefix: `${ns}lease:`, leaseSize: 5, leaseTtlMs: 10_000 });
    const allowed = await burst(leased, 'user', 200);
    expect(allowed).toBe(10);
    // 2 leases of 5 tokens + 1 empty answer; the in-flight dedupe stops 200 calls.
    expect(leased.calls).toBeLessThanOrEqual(4);
  });

  it('leasing can falsely deny: tokens stranded in another instance', async () => {
    const make = () =>
      new LeasedTokenBucket(r, { ...config, prefix: `${ns}strand:`, leaseSize: 10, leaseTtlMs: 10_000 });
    const a = make();
    const b = make();
    // A takes one request but leases all 10 tokens; it holds 9 unused.
    expect((await a.consume('user')).allowed).toBe(true);
    // B is denied, even though only 1 of 10 tokens was actually used.
    expect((await b.consume('user')).allowed).toBe(false);
  });
});
