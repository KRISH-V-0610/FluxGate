import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.js';

/**
 * A line of the text format is a comment (# HELP / # TYPE) or
 *   name{label="value",...} number
 * where label values may contain escaped \\, \" and \n.
 */
const SAMPLE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\\n]|\\[\\"n])*",?)*\})? (-?[0-9.e+-]+|[+-]Inf|NaN)$/;

describe('Metrics (Prometheus text format)', () => {
  it('every line is a valid comment or sample, and the output ends with a newline', () => {
    const metrics = new Metrics();
    metrics.record('api', 'allowed', 0.0003, 1);
    metrics.record('api', 'denied', 0.2, 5);
    metrics.counter('fluxgate_redis_calls_total', 'Calls to Redis.', () => 42);
    const text = metrics.render();
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
      expect(line).toMatch(SAMPLE);
    }
  });

  it('starts all four outcomes at zero, so dashboards see the series before the first event', () => {
    const metrics = new Metrics();
    metrics.declare('login');
    const text = metrics.render();
    for (const outcome of ['allowed', 'denied', 'degraded', 'unavailable']) {
      expect(text).toContain(`fluxgate_decisions_total{limiter="login",outcome="${outcome}"} 0`);
    }
  });

  it('histogram buckets are cumulative, +Inf equals the count, and the sum adds up', () => {
    const metrics = new Metrics({ buckets: [0.001, 0.01, 0.1] });
    for (const seconds of [0.0005, 0.001, 0.005, 0.05, 2]) metrics.record('api', 'allowed', seconds);
    const text = metrics.render();
    const bucket = (le: string) => `fluxgate_limiter_duration_seconds_bucket{limiter="api",outcome="allowed",le="${le}"}`;
    expect(text).toContain(`${bucket('0.001')} 2`); // le is "less than or equal"
    expect(text).toContain(`${bucket('0.01')} 3`);
    expect(text).toContain(`${bucket('0.1')} 4`);
    expect(text).toContain(`${bucket('+Inf')} 5`);
    expect(text).toContain('fluxgate_limiter_duration_seconds_count{limiter="api",outcome="allowed"} 5');
    const sum = Number(text.match(/fluxgate_limiter_duration_seconds_sum\{limiter="api",outcome="allowed"\} (\S+)/)![1]);
    expect(sum).toBeCloseTo(2.0565, 10);
  });

  it('declares each metric once with HELP and TYPE', () => {
    const metrics = new Metrics();
    metrics.record('a', 'allowed', 0.001);
    metrics.record('b', 'allowed', 0.001);
    const text = metrics.render();
    expect(text.match(/# TYPE fluxgate_decisions_total counter/g)).toHaveLength(1);
    expect(text).toContain('# TYPE fluxgate_limiter_duration_seconds histogram');
  });

  it('escapes backslashes, quotes and newlines in label values', () => {
    const metrics = new Metrics();
    metrics.record('we"ird\\name\n', 'allowed', 0.001);
    expect(metrics.render()).toContain('fluxgate_decisions_total{limiter="we\\"ird\\\\name\\n",outcome="allowed"} 1');
  });

  it('reads collected counters and gauges at scrape time, with optional labels', () => {
    let calls = 0;
    const metrics = new Metrics()
      .counter('fluxgate_redis_calls_total', 'Calls to Redis.', () => calls)
      .gauge('fluxgate_policies', 'Configured policies.', () => [
        { labels: { policy: 'free' }, value: 1 },
        { labels: { policy: 'pro' }, value: 1 },
      ]);
    calls = 7;
    const text = metrics.render();
    expect(text).toContain('# TYPE fluxgate_redis_calls_total counter\nfluxgate_redis_calls_total 7');
    expect(text).toContain('# TYPE fluxgate_policies gauge');
    expect(text).toContain('fluxgate_policies{policy="pro"} 1');
  });

  it('rejects invalid metric names, duplicates and bad buckets', () => {
    expect(() => new Metrics().counter('bad-name', 'x', () => 1)).toThrow(RangeError);
    expect(() => new Metrics().counter('ok', 'x', () => 1).gauge('ok', 'x', () => 1)).toThrow(/already registered/);
    expect(() => new Metrics({ buckets: [0.1, 0.01] })).toThrow(RangeError);
    expect(() => new Metrics({ buckets: [] })).toThrow(RangeError);
  });
});
