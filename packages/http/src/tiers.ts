import type { AnyRateLimiter } from '@fluxgate/core';

export interface TierOptions<Context = unknown> {
  /** Tier name → the limiter for that tier (each with its own key prefix). */
  tiers: Record<string, AnyRateLimiter>;
  /**
   * Which tier does this caller belong to? In production this is a lookup of
   * the API key in your database or cache. `context` is the framework's request.
   */
  tierOf: (key: string, context: Context) => string;
  /** Used when tierOf names a tier that doesn't exist. */
  fallback: string;
}

/**
 * Per-caller plans, e.g. free = 10 req/s and pro = 100 req/s. Returns a
 * function to pass as `limiter` to createCheck or any adapter.
 */
export function byTier<Context = unknown>(options: TierOptions<Context>): (key: string, context: Context) => AnyRateLimiter {
  const fallback = options.tiers[options.fallback];
  if (fallback === undefined) throw new Error(`fallback tier "${options.fallback}" is not defined`);
  return (key, context) => options.tiers[options.tierOf(key, context)] ?? fallback;
}
