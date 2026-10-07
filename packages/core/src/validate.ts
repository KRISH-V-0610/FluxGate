/** Throws early on a bad config instead of silently allowing or denying everything later. */
export function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
}

/**
 * A request's cost, checked: default 1, otherwise a positive whole number.
 * Whole units keep "cost N = N requests of cost 1" exact for every algorithm.
 */
export function resolveCost(cost: number | undefined): number {
  if (cost === undefined) return 1;
  if (!Number.isSafeInteger(cost) || cost < 1) {
    throw new RangeError(`cost must be a positive whole number, got ${cost}`);
  }
  return cost;
}
