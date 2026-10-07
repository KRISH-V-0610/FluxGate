// Framework-agnostic parts. Each framework adapter has its own entry point
// (@flux-gate/http/express, /fastify, /hono, /fetch), so installing this
// package never pulls in a framework you don't use.
export { createCheck } from './check.js';
export type { Check, CheckOptions, CheckRequest, Decision, FailMode, Outcome, Rejection } from './check.js';
export { Metrics, DEFAULT_BUCKETS } from './metrics.js';
export type { Sample } from './metrics.js';
export { byTier } from './tiers.js';
export type { TierOptions } from './tiers.js';
