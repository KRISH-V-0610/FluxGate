import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

/**
 * Runs a Lua script efficiently.
 *
 * Redis caches scripts by their SHA-1. EVALSHA sends only the 40-char hash
 * instead of the whole script on every request. If Redis doesn't have it
 * (first call, or after a restart / SCRIPT FLUSH) it replies NOSCRIPT, and
 * we fall back to EVAL once, which also caches it for next time.
 */
export class LuaScript {
  readonly sha: string;

  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  /** Load a script from packages/redis/lua/. Works from both src/ and dist/ (each is one level deep). */
  static fromFile(name: string): LuaScript {
    return new LuaScript(readFileSync(new URL(`../lua/${name}`, import.meta.url), 'utf8'));
  }

  async run(redis: Redis, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
        return redis.eval(this.source, keys.length, ...keys, ...args);
      }
      throw err;
    }
  }
}
