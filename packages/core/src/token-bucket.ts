import type { RateLimiter, RateLimitResult, TokenBucketConfig } from './types.js';
import { assertPositive } from './validate.js';

/**
 * Floating-point slack. Refill adds fractions like 0.1 + 0.2, which can land
 * on 0.9999999999999999 instead of 1, and long runs accumulate drift. One
 * millionth of a token is far below anything meaningful, yet far above the
 * rounding error. Without it, a client would sometimes be denied at the
 * exact moment it earned its token.
 */
const EPSILON = 1e-6;

/** Everything a token bucket needs to remember about one key. */
export interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

/**
 * One token-bucket decision as a pure function: (old state, now) → (new state, result).
 *
 * It's separate from the class so that the in-memory limiter and the naive
 * Redis limiter run exactly the same math. The only difference between
 * them is *where* the state lives, which keeps the race-condition
 * experiment a controlled one.
 */
export function tokenBucketStep(
  state: TokenBucketState | undefined,
  config: TokenBucketConfig,
  now: number,
): { state: TokenBucketState; result: RateLimitResult } {
  const { capacity } = config;
  const refillPerMs = config.refillPerSecond / 1000;

  // A key we've never seen (or whose state expired) starts with a full bucket.
  const previous = state ?? { tokens: capacity, lastRefill: now };

  // Lazy refill: add what dripped in since we last looked, capped at capacity.
  // max(0, ...) guards against a clock that steps backwards.
  const elapsed = Math.max(0, now - previous.lastRefill);
  let tokens = Math.min(capacity, previous.tokens + elapsed * refillPerMs);

  const allowed = tokens >= 1 - EPSILON;
  if (allowed) tokens = Math.max(0, tokens - 1);

  return {
    state: { tokens, lastRefill: now },
    result: {
      allowed,
      limit: capacity,
      remaining: Math.floor(tokens + EPSILON),
      resetMs: Math.ceil((capacity - tokens) / refillPerMs),
      ...(allowed ? {} : { retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) }),
    },
  };
}

/**
 * Token bucket.
 *
 * Real systems: Stripe's API limiter, AWS API Gateway throttling and Envoy's
 * local rate limit all use it.
 *
 * Core idea: each key has a bucket holding up to `capacity` tokens. Every
 * request takes one token, and tokens drip back in continuously at
 * `refillPerSecond`. The bucket isn't refilled by a timer. On each request
 * we work out how many tokens would have dripped in since we last looked
 * (elapsed x rate), so the state is just two numbers: tokens and lastRefill.
 *
 * Tradeoff: it separates two things the window algorithms combine. Burst
 * size (`capacity`) and long-run rate (`refillPerSecond`) are tuned
 * independently. There is no window edge to game. The catch is that a full
 * bucket allows `capacity` requests instantly, which is intended but must be
 * sized carefully.
 */
export class TokenBucketLimiter implements RateLimiter {
  private config: TokenBucketConfig;
  private buckets = new Map<string, TokenBucketState>();

  constructor(config: TokenBucketConfig) {
    assertPositive('capacity', config.capacity);
    assertPositive('refillPerSecond', config.refillPerSecond);
    this.config = { ...config };
  }

  consume(key: string, now: number = Date.now()): RateLimitResult {
    const { state, result } = tokenBucketStep(this.buckets.get(key), this.config, now);
    this.buckets.set(key, state);
    return result;
  }
}
