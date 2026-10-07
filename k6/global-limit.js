// Proves the limit is GLOBAL across 3 instances behind nginx.
//
// One API key sends 100 req/s for 10 s through nginx, which spreads them
// round-robin over app1..app3. With the free tier (capacity 20, refill 2/s)
// a correct global limiter admits about 20 + 2 * 10 = 40 requests in total,
// whichever instance served them. With STORE=memory each instance has its
// own bucket, so expect about 3x that.
//
//   docker compose --profile bench run --rm k6
//   STORE=memory docker compose up -d && STORE=memory docker compose --profile bench run --rm k6
//   docker compose --profile bench run --rm -e RATE=2000 -e SECONDS=5 -e RUN_LABEL=redis-lua-2000rps k6

import http from 'k6/http';
import { Counter } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'http://localhost:8080';
const RATE = Number(__ENV.RATE || 100);
const SECONDS = Number(__ENV.SECONDS || 10);

const allowed = new Counter('fluxgate_allowed');
const limited = new Counter('fluxgate_limited');
const degraded = new Counter('fluxgate_degraded');
const byInstance = {
  app1: new Counter('fluxgate_allowed_app1'),
  app2: new Counter('fluxgate_allowed_app2'),
  app3: new Counter('fluxgate_allowed_app3'),
};
const servedBy = {
  app1: new Counter('fluxgate_served_app1'),
  app2: new Counter('fluxgate_served_app2'),
  app3: new Counter('fluxgate_served_app3'),
};

export const options = {
  scenarios: {
    hammer: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${SECONDS}s`,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// setup() runs once, so every VU shares the same fresh API key.
export function setup() {
  return { key: `k6_${Date.now()}` };
}

export default function (data) {
  const res = http.get(`${TARGET}/api/hello`, { headers: { 'x-api-key': data.key } });
  const instance = res.headers['X-Instance-Id'];
  if (servedBy[instance]) servedBy[instance].add(1);
  if (res.status === 200) {
    allowed.add(1);
    if (byInstance[instance]) byInstance[instance].add(1);
    if (res.headers['X-Ratelimit-Status'] === 'degraded') degraded.add(1);
  } else if (res.status === 429) {
    limited.add(1);
  }
}

export function handleSummary(data) {
  const count = (name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
  const d = data.metrics.http_req_duration.values;
  const result = {
    label: __ENV.RUN_LABEL || 'unknown',
    rate: RATE,
    seconds: SECONDS,
    sent: count('http_reqs'),
    allowed: count('fluxgate_allowed'),
    limited: count('fluxgate_limited'),
    degraded: count('fluxgate_degraded'),
    expectedGlobal: 20 + 2 * SECONDS,
    allowedByInstance: { app1: count('fluxgate_allowed_app1'), app2: count('fluxgate_allowed_app2'), app3: count('fluxgate_allowed_app3') },
    servedByInstance: { app1: count('fluxgate_served_app1'), app2: count('fluxgate_served_app2'), app3: count('fluxgate_served_app3') },
    latencyMs: { p50: d.med, p90: d['p(90)'], p95: d['p(95)'], p99: d['p(99)'], max: d.max },
  };
  const text = `\n${JSON.stringify(result, null, 2)}\n`;
  return {
    stdout: text,
    [`/results/k6-${result.label}.json`]: JSON.stringify(result, null, 2),
  };
}
