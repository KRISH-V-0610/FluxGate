/**
 * Turns results/*.json into markdown tables and mermaid charts, and writes
 * them into README.md and docs/REPORT.md between marker comments:
 *
 *   <!-- results:race:start -->  ...generated...  <!-- results:race:end -->
 *
 * So the numbers in the docs always come from the last benchmark run,
 * never typed by hand.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RESULTS_DIR, ROOT } from './common.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function load(name: string): Json | undefined {
  const file = `${RESULTS_DIR}${name}.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function chart(opts: { title: string; x: (string | number)[]; yLabel: string; yMax: number; bar?: number[]; lines?: number[][] }): string {
  const fmt = (xs: number[]) => `[${xs.map((v) => Math.round(v * 1000) / 1000).join(', ')}]`;
  return [
    '```mermaid',
    'xychart-beta',
    `  title "${opts.title}"`,
    `  x-axis [${opts.x.map((x) => `"${x}"`).join(', ')}]`,
    `  y-axis "${opts.yLabel}" 0 --> ${opts.yMax}`,
    ...(opts.bar ? [`  bar ${fmt(opts.bar)}`] : []),
    ...(opts.lines ?? []).map((l) => `  line ${fmt(l)}`),
    '```',
  ].join('\n');
}

const sections: Record<string, () => string | undefined> = {
  race() {
    const r = load('race');
    if (!r) return;
    const levels = [...new Set<number>(r.rows.map((x: Json) => x.concurrency))];
    const pick = (prefix: string) => levels.map((c) => r.rows.find((x: Json) => x.concurrency === c && x.limiter.startsWith(prefix)));
    const naive = pick('naive');
    const lua = pick('atomic');
    return [
      chart({
        title: `Admitted out of ${r.setup.requests} (capacity ${r.setup.capacity}): bars = naive, line = Lua`,
        x: levels,
        yLabel: 'requests admitted',
        yMax: r.setup.requests,
        bar: naive.map((x: Json) => x.admittedMean),
        lines: [lua.map((x: Json) => x.admittedMean)],
      }),
      '',
      table(
        ['concurrent clients', 'naive: admitted (mean / max)', 'naive: × limit', 'Lua: admitted (mean / max)', 'Lua: × limit'],
        levels.map((c, i) => [c, `${naive[i].admittedMean} / ${naive[i].admittedMax}`, `${naive[i].overAdmission}×`, `${lua[i].admittedMean} / ${lua[i].admittedMax}`, `${lua[i].overAdmission}×`]),
      ),
      '',
      `<sub>${r.setup.trials} trials per cell, ${r.setup.requests} requests for one key, each client on its own Redis connection. Source: \`results/race.json\`.</sub>`,
    ].join('\n');
  },

  accuracy() {
    const r = load('accuracy');
    if (!r) return;
    const patterns: Json[] = r.setup.patterns;
    const algos = [...new Set<string>(r.rows.map((x: Json) => x.algorithm))];
    const cell = (p: string, a: string) => r.rows.find((x: Json) => x.pattern === p && x.algorithm === a);
    return [
      '**Peak admitted in any 60 s window, as a multiple of the limit** (1.00 = never exceeded):',
      '',
      table(
        ['algorithm', ...patterns.map((p) => `${p.name}<br><sub>${p.description}</sub>`)],
        algos.map((a) => [a, ...patterns.map((p) => `${cell(p.name, a).peakOverLimit.toFixed(2)}×`)]),
      ),
      '',
      '**Wrong decisions, judged against the definition "at most `limit` in any window"** (wrong allow / wrong deny, % of all requests):',
      '',
      table(
        ['algorithm', ...patterns.map((p) => p.name)],
        algos.map((a) => [a, ...patterns.map((p) => `${cell(p.name, a).wrongAllowPct}% / ${cell(p.name, a).wrongDenyPct}%`)]),
      ),
      '',
      `<sub>Limit ${r.setup.limit} per ${r.setup.windowMs / 1000} s, ${r.setup.durationMs / 3_600_000} simulated hours per pattern, seeded PRNG (deterministic). Token bucket and GCRA are configured as capacity = limit, refill = limit / window; they intentionally allow bursts, so they are shown for reference, not judged as "wrong". Source: \`results/accuracy.json\`.</sub>`,
    ].join('\n');
  },

  latency() {
    const r = load('latency');
    if (!r) return;
    return [
      table(
        ['store', 'in flight', 'p50 (ms)', 'p99 (ms)', 'throughput (decisions/s)', 'Redis calls / request'],
        r.rows.map((x: Json) => [x.store, x.inFlight, x.p50, x.p99, x.throughputPerSec.toLocaleString('en-US'), x.redisCallsPerRequest]),
      ),
      '',
      `<sub>${r.setup.note}. One process, one connection. Source: \`results/latency.json\`.</sub>`,
    ].join('\n');
  },

  service() {
    const r = load('service');
    if (!r) return;
    return [
      table(
        ['mode', 'store', 'in flight', 'p50 (ms)', 'p99 (ms)', 'throughput (decisions/s)', 'Redis calls / decision'],
        r.rows.map((x: Json) => [x.mode, x.store, x.inFlight, x.p50, x.p99, x.throughputPerSec.toLocaleString('en-US'), x.redisCallsPerRequest]),
      ),
      '',
      `<sub>${r.setup.note}. "service" = \`@fluxgate/client\` → HTTP → the FluxGate server as a separate process (lease size ${r.setup.leaseSize} for redis-leased). One hot key, nothing denied. Source: \`results/service.json\`.</sub>`,
    ].join('\n');
  },

  leasing() {
    const r = load('leasing');
    if (!r) return;
    const under = r.rows.filter((x: Json) => x.load === 'under');
    const over = r.rows.filter((x: Json) => x.load === 'overload');
    return [
      chart({
        title: 'Redis calls per request vs lease size: bars = under limit, line = overload',
        x: under.map((x: Json) => x.limiter.replace('atomic (no lease)', 'atomic').replace('lease ', '')),
        yLabel: 'Redis calls / request',
        yMax: 1,
        bar: under.map((x: Json) => x.redisCallsPerRequest),
        lines: [over.map((x: Json) => x.redisCallsPerRequest)],
      }),
      '',
      table(
        ['load', 'limiter', 'requests', 'admitted', 'vs atomic', 'peak in 1 s (bound)', 'Redis calls / req', 'p50 (ms)', 'p99 (ms)'],
        r.rows.map((x: Json) => [x.load, x.limiter, x.requests, x.admitted, `${x.admittedVsBaseline}×`, `${x.peakIn1s} (${x.bound1s})`, x.redisCallsPerRequest, x.p50, x.p99]),
      ),
      '',
      `<sub>${r.setup.instances} instances sharing one bucket (capacity ${r.setup.bucket.capacity}, refill ${r.setup.bucket.refillPerSecond}/s); Poisson load of ${r.setup.ratePerInstance.under} (under) or ${r.setup.ratePerInstance.overload} (overload) req/s per instance for ${r.setup.durationMs / 1000} s; lease TTL ${r.setup.leaseTtlMs} ms. Source: \`results/leasing.json\`.</sub>`,
    ].join('\n');
  },

  failover() {
    const r = load('failover');
    if (!r) return;
    const slices = r.results[0].slices;
    return [
      chart({
        title: `p99 latency per 500 ms while Redis is paused (${r.setup.pausedFromMs / 1000}-${r.setup.resumedAtMs / 1000} s)`,
        x: slices.map((s: Json) => s.t),
        yLabel: 'p99 latency (ms)',
        yMax: Math.ceil(Math.max(...r.results.flatMap((v: Json) => v.slices.map((s: Json) => s.p99ms))) / 500) * 500,
        lines: r.results.map((v: Json) => v.slices.map((s: Json) => s.p99ms)),
      }),
      '',
      `<sub>Lines, top to bottom: ${r.results.map((v: Json) => v.variant).join(', ')} (fail-open and fail-closed overlap at about 115 ms).</sub>`,
      '',
      table(
        ['configuration', 'requests during outage', 'served (HTTP 200)', 'p50 (ms)', 'p99 (ms)', 'what the client saw'],
        r.results.map((v: Json) => [
          v.variant,
          v.summary.requestsDuringOutage,
          `${v.summary.servedDuringOutagePct}%`,
          v.summary.p50DuringOutageMs,
          v.summary.p99DuringOutageMs,
          v.variant === 'library defaults'
            ? 'requests hang until Redis returns'
            : v.variant === 'fail-open'
              ? '200 + `X-RateLimit-Status: degraded` (unlimited)'
              : '503 Service Unavailable',
        ]),
      ),
      '',
      `<sub>${r.setup.ratePerSecond} req/s open-loop against the real Express app; \`docker compose pause redis\` at ${r.setup.pausedFromMs / 1000} s, \`unpause\` at ${r.setup.resumedAtMs / 1000} s (the commands take ~0.3 s to land, so the edge slices are mixed). "Served" counts requests sent during the pause window. Source: \`results/failover.json\`.</sub>`,
    ].join('\n');
  },

  k6() {
    const runs = ['memory', 'redis-naive', 'redis-lua', 'redis-leased', 'redis-naive-2000rps', 'redis-lua-2000rps']
      .map((n) => load(`k6-${n}`))
      .filter(Boolean);
    if (runs.length === 0) return;
    return [
      table(
        ['store', 'load', 'requests', 'allowed', 'correct global limit', 'allowed per instance (app1/app2/app3)', 'p99 (ms)'],
        runs.map((x: Json) => {
          const ratio = Math.round((x.allowed / x.expectedGlobal) * 100) / 100;
          return [
            `\`${x.label.replace(/-\d+rps$/, '')}\``,
            `${x.rate} req/s × ${x.seconds} s`,
            x.sent,
            `**${x.allowed}**`,
            `${x.expectedGlobal} (${ratio}×)`,
            `${x.allowedByInstance.app1} / ${x.allowedByInstance.app2} / ${x.allowedByInstance.app3}`,
            Math.round(x.latencyMs.p99 * 10) / 10,
          ];
        }),
      ),
      '',
      '<sub>k6 (constant arrival rate) → Nginx round-robin → 3 app instances → 1 Redis, all in Docker Compose. One API key, free tier (capacity 20, refill 2/s), so the correct total is 20 + 2 × seconds. Source: `results/k6-*.json`.</sub>',
    ].join('\n');
  },
};

for (const doc of ['README.md', 'docs/REPORT.md']) {
  const path = `${ROOT}${doc}`;
  if (!existsSync(path)) continue;
  let text = readFileSync(path, 'utf8');
  let replaced = 0;
  for (const [name, render] of Object.entries(sections)) {
    const pattern = new RegExp(`(<!-- results:${name}:start -->)[\\s\\S]*?(<!-- results:${name}:end -->)`, 'g');
    if (!pattern.test(text)) continue;
    const body = render();
    if (body === undefined) {
      console.warn(`  ${doc}: no results for "${name}" (run its benchmark first)`);
      continue;
    }
    text = text.replace(pattern, (_m, start: string, end: string) => `${start}\n${body}\n${end}`);
    replaced++;
  }
  writeFileSync(path, text);
  console.log(`→ ${doc}: updated ${replaced} section(s)`);
}
