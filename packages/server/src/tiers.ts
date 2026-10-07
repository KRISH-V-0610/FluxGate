import type { Request } from 'express';
import type { AnyRateLimiter } from '@fluxgate/core';

export interface TierOptions {
  /** Tier name → the limiter for that tier (each with its own key prefix). */
  tiers: Record<string, AnyRateLimiter>;
  /** Which tier does this caller belong to? In production: a DB/cache lookup of the API key. */
  tierOf: (key: string, req: Request) => string;
  /** Used when tierOf names a tier that doesn't exist. */
  fallback: string;
}

/**
 * Per-key tiers, e.g. free = 10 req/s, pro = 100 req/s. It returns the function
 * the middleware calls to pick a limiter for each request.
 */
export function byTier(options: TierOptions): (req: Request, key: string) => AnyRateLimiter {
  const fallback = options.tiers[options.fallback];
  if (fallback === undefined) throw new Error(`fallback tier "${options.fallback}" is not defined`);
  return (req, key) => options.tiers[options.tierOf(key, req)] ?? fallback;
}

/**
 * Demo tier rule: API keys starting with "pro_" are pro, everything else
 * (including anonymous IPs) is free. A real system would look the key up.
 */
export function demoTierOf(key: string): 'pro' | 'free' {
  return key.startsWith('key:pro_') ? 'pro' : 'free';
}
