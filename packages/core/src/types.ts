/**
 * The answer a limiter gives for one request. Every algorithm returns this
 * same shape, so the HTTP layer can turn it into headers without knowing
 * which algorithm produced it.
 */
export interface RateLimitResult {
  /** Was this request let through? */
  allowed: boolean;
  /** The configured maximum (requests per window, or bucket capacity). */
  limit: number;
  /** How many more requests would be allowed right now. Never negative. */
  remaining: number;
  /** Milliseconds until this key is completely back to a fresh state. */
  resetMs: number;
  /** Only set when denied: milliseconds until a retry can succeed. */
  retryAfterMs?: number;
}

/**
 * The contract every in-memory algorithm implements.
 *
 * `now` is injectable so tests can control time exactly (no sleeps, no
 * flaky timing). In production it defaults to Date.now().
 */
export interface RateLimiter {
  consume(key: string, now?: number): RateLimitResult;
}

/**
 * The same contract for limiters whose state lives somewhere else (Redis),
 * so every call is network I/O and returns a Promise. They take no `now`
 * because the clock belongs to the store (see DESIGN.md, "whose clock?").
 */
export interface AsyncRateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

/** Anything the middleware can sit in front of. */
export type AnyRateLimiter = RateLimiter | AsyncRateLimiter;

/** "At most `limit` requests per `windowMs`", the window-based algorithms' config. */
export interface FixedWindowConfig {
  limit: number;
  windowMs: number;
}

export interface SlidingWindowLogConfig {
  limit: number;
  windowMs: number;
}

export interface SlidingWindowCounterConfig {
  limit: number;
  windowMs: number;
}

/** A bucket holding up to `capacity` tokens, refilled continuously at `refillPerSecond`. */
export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

/**
 * GCRA is configured like a token bucket, which makes the two directly
 * comparable: `burst` = how many back-to-back requests are allowed,
 * `ratePerSecond` = the sustained rate.
 */
export interface GcraConfig {
  burst: number;
  ratePerSecond: number;
}
