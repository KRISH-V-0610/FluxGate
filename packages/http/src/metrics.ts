import type { Outcome } from './check.js';

/**
 * Latency buckets in seconds, from 50 µs (an in-memory decision) to 1 s (a
 * limiter that's about to time out). Redis round trips land around 0.25-1 ms.
 */
export const DEFAULT_BUCKETS = [
  0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
];

const OUTCOMES: readonly Outcome[] = ['allowed', 'denied', 'degraded', 'unavailable'];
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** One value of a metric that the registry reads from somewhere else at scrape time. */
export interface Sample {
  labels?: Record<string, string>;
  value: number;
}

interface Collected {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  read: () => number | Sample[];
}

interface Series {
  decisions: number;
  units: number;
  /** Per-bucket counts (not cumulative), plus one slot for "above the last bucket". */
  buckets: number[];
  sum: number;
}

/**
 * A minimal Prometheus registry that speaks the text exposition format
 * (version 0.0.4) without a client library. It records:
 *
 *   fluxgate_decisions_total{limiter, outcome}            counter
 *   fluxgate_cost_units_total{limiter, outcome}           counter
 *   fluxgate_limiter_duration_seconds{limiter, outcome}   histogram
 *
 * Labels are the limiter's name and the outcome, never the rate-limited key.
 * A label per API key or IP would create one time series per caller, and
 * that's how Prometheus servers run out of memory.
 *
 *     const metrics = new Metrics();
 *     app.use(fluxgate({ limiter, metrics, name: 'api' }));
 *     app.get('/metrics', (_req, res) => res.type(metrics.contentType).send(metrics.render()));
 */
export class Metrics {
  readonly contentType = 'text/plain; version=0.0.4; charset=utf-8';
  private readonly buckets: number[];
  private readonly series = new Map<string, Map<Outcome, Series>>();
  private readonly collected: Collected[] = [];

  constructor(options: { buckets?: number[] } = {}) {
    const buckets = options.buckets ?? DEFAULT_BUCKETS;
    if (buckets.length === 0 || buckets.some((b, i) => !(b > 0) || (i > 0 && b <= buckets[i - 1]!))) {
      throw new RangeError('buckets must be positive and strictly increasing');
    }
    this.buckets = [...buckets];
  }

  /**
   * Starts every outcome of this limiter at zero, so dashboards and rate()
   * see the series from the first scrape instead of from the first denial.
   * createCheck calls it for you.
   */
  declare(limiter: string): void {
    if (this.series.has(limiter)) return;
    const byOutcome = new Map<Outcome, Series>();
    for (const outcome of OUTCOMES) {
      byOutcome.set(outcome, { decisions: 0, units: 0, buckets: new Array<number>(this.buckets.length + 1).fill(0), sum: 0 });
    }
    this.series.set(limiter, byOutcome);
  }

  /** Records one decision: what happened, how long the limiter took, and how many units were asked for. */
  record(limiter: string, outcome: Outcome, seconds: number, cost = 1): void {
    this.declare(limiter);
    const s = this.series.get(limiter)!.get(outcome)!;
    s.decisions++;
    s.units += cost;
    s.sum += seconds;
    let i = 0;
    while (i < this.buckets.length && seconds > this.buckets[i]!) i++;
    s.buckets[i]!++;
  }

  /** Exposes a counter kept elsewhere, read at scrape time (e.g. Redis calls made by a limiter). */
  counter(name: string, help: string, read: () => number | Sample[]): this {
    return this.collect({ name, help, type: 'counter', read });
  }

  /** Exposes a value that goes up and down, read at scrape time. */
  gauge(name: string, help: string, read: () => number | Sample[]): this {
    return this.collect({ name, help, type: 'gauge', read });
  }

  private collect(metric: Collected): this {
    if (!NAME.test(metric.name)) throw new RangeError(`invalid metric name "${metric.name}"`);
    if (this.collected.some((m) => m.name === metric.name)) throw new Error(`metric "${metric.name}" is already registered`);
    this.collected.push(metric);
    return this;
  }

  /** The whole registry in Prometheus text format: the body of GET /metrics. */
  render(): string {
    const out: string[] = [];
    const each = (fn: (limiter: string, outcome: Outcome, s: Series) => void) => {
      for (const [limiter, byOutcome] of this.series) for (const [outcome, s] of byOutcome) fn(limiter, outcome, s);
    };

    header(out, 'fluxgate_decisions_total', 'Rate-limit decisions, by limiter and outcome.', 'counter');
    each((limiter, outcome, s) => out.push(`fluxgate_decisions_total${labels({ limiter, outcome })} ${s.decisions}`));

    header(out, 'fluxgate_cost_units_total', 'Units asked for (the sum of request costs), by limiter and outcome.', 'counter');
    each((limiter, outcome, s) => out.push(`fluxgate_cost_units_total${labels({ limiter, outcome })} ${s.units}`));

    const histogram = 'fluxgate_limiter_duration_seconds';
    header(out, histogram, 'Time to reach a decision, including limiter failures and timeouts.', 'histogram');
    each((limiter, outcome, s) => {
      // Prometheus buckets are cumulative: le="0.001" counts everything at or below 1 ms.
      let cumulative = 0;
      this.buckets.forEach((le, i) => {
        cumulative += s.buckets[i]!;
        out.push(`${histogram}_bucket${labels({ limiter, outcome, le: number(le) })} ${cumulative}`);
      });
      out.push(`${histogram}_bucket${labels({ limiter, outcome, le: '+Inf' })} ${s.decisions}`);
      out.push(`${histogram}_sum${labels({ limiter, outcome })} ${number(s.sum)}`);
      out.push(`${histogram}_count${labels({ limiter, outcome })} ${s.decisions}`);
    });

    for (const metric of this.collected) {
      header(out, metric.name, metric.help, metric.type);
      const value = metric.read();
      const samples = typeof value === 'number' ? [{ value }] : value;
      for (const s of samples) out.push(`${metric.name}${labels(s.labels ?? {})} ${number(s.value)}`);
    }

    return `${out.join('\n')}\n`;
  }
}

function header(out: string[], name: string, help: string, type: string): void {
  out.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
  out.push(`# TYPE ${name} ${type}`);
}

/** {a="1",b="2"}, with the three characters the format reserves escaped. */
function labels(values: Record<string, string>): string {
  const pairs = Object.entries(values).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function number(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}
