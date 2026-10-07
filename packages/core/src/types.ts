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
  /**
   * Only set when denied: milliseconds until a retry can succeed. A denial
   * *without* it means waiting can never help: the request's cost is larger
   * than the limit itself.
   */
  retryAfterMs?: number;
}

/** Per-request options shared by every limiter. */
export interface ConsumeOptions {
  /**
   * How many units this request uses. Default 1; must be a positive whole
   * number. It lets one limiter meter work instead of requests: LLM tokens,
   * rows exported, emails sent. A request of cost N is admitted only if N
   * requests of cost 1 would all be admitted in a row, so each algorithm's
   * guarantees carry over unchanged, just counted in units.
   */
  cost?: number;
}

/** In-memory limiters also accept the time, so tests can control the clock. */
export interface LocalConsumeOptions extends ConsumeOptions {
  /** Milliseconds since the epoch. Default Date.now(). */
  now?: number;
}

/**
 * The contract every in-memory algorithm implements.
 *
 * `now` is injectable so tests can control time exactly (no sleeps, no
 * flaky timing). In production it defaults to Date.now().
 */
export interface RateLimiter {
  consume(key: string, options?: LocalConsumeOptions): RateLimitResult;
}

/**
 * The same contract for limiters whose state lives somewhere else (Redis),
 * so every call is network I/O and returns a Promise. They take no `now`
 * because the clock belongs to the store (see DESIGN.md, "whose clock?").
 */
export interface AsyncRateLimiter {
  consume(key: string, options?: ConsumeOptions): Promise<RateLimitResult>;
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
