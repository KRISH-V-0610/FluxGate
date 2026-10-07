import type { TokenBucketConfig } from '@flux-gate/core';

/**
 * Named limits that callers pick by name, e.g. "free" = burst 20, 2 per
 * second. Configured once in the POLICIES environment variable:
 *
 *   POLICIES='{"free":{"capacity":20,"refillPerSecond":2},"login":{"capacity":5,"refillPerSecond":0.1}}'
 */
export type Policies = Record<string, TokenBucketConfig>;

// Policy names end up in Redis keys and metric labels, so keep them plain.
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const EXAMPLE = '{"free":{"capacity":20,"refillPerSecond":2}}';

export function parsePolicies(json: string): Policies {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(`POLICIES must be valid JSON, e.g. ${EXAMPLE}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new Error(`POLICIES must be a non-empty JSON object, e.g. ${EXAMPLE}`);
  }

  const policies: Policies = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME.test(name)) throw new Error(`policy name "${name}" may only use letters, digits, _ and - (up to 64)`);
    const { capacity, refillPerSecond } = (value ?? {}) as Record<string, unknown>;
    if (typeof capacity !== 'number' || typeof refillPerSecond !== 'number') {
      throw new Error(`policy "${name}" needs numeric capacity and refillPerSecond, e.g. ${EXAMPLE}`);
    }
    policies[name] = { capacity, refillPerSecond };
  }
  return policies;
}
