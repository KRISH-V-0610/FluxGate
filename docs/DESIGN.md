# FluxGate: how it works and why

This document explains every part of FluxGate in plain language: what each file does, why it's built that way, and which alternatives were rejected. It ends with questions an interviewer is likely to ask, with answers.

---

## Part 1: the problem

A **rate limiter** answers one question per request: *"has this client used up its allowance?"* If yes, the server replies `429 Too Many Requests` instead of doing the work.

Why services need one:
- **Protection.** Stop one client (buggy script, scraper, attacker) from overloading the service for everyone.
- **Fairness.** Every customer gets their share.
- **Cost.** Each request may cost money downstream (SMS, LLM calls, payment APIs).
- **Business tiers.** Free users get 20 req/s, paying users get 200.

On **one server** this is easy: keep a counter in memory. The interesting part starts when you run **several copies** of the server behind a load balancer, which every real service does:

```
client → load balancer → app1 / app2 / app3
```

If each app counts in its own memory, a client with a limit of 100 can get 100 from *each* app: 300 in total. So the count must live somewhere **shared**, which is Redis here. Shared state brings three distributed-systems problems, and this project hits all of them:

1. **Race conditions.** Two apps read the same counter at the same time, and both think there's room.
2. **Clocks.** The apps' clocks disagree slightly. Whose time decides when tokens refill?
3. **Partial failure.** What if Redis is slow or down? Every request now depends on it.

---

## Part 2: the five algorithms (`packages/core`)

They all implement one interface:

```ts
interface RateLimiter {
  consume(key: string, options?: { cost?: number; now?: number }): RateLimitResult;
}
interface RateLimitResult {
  allowed: boolean;
  limit: number;          // for the X-RateLimit-Limit header
  remaining: number;      // for X-RateLimit-Remaining
  resetMs: number;        // ms until the limiter is fully reset
  retryAfterMs?: number;  // only when denied: ms until the next request could succeed
}
```

**Why `now` is a parameter.** Tests can pass exact timestamps (`consume('a', { now: 1000 })`, then `consume('a', { now: 1999 })`) instead of sleeping or mocking `Date.now()`. That makes every test instant and deterministic, and it makes the accuracy experiment able to simulate 2 hours of traffic in milliseconds.

**Weighted cost (`cost`).** Not every request is equal: one LLM call can use 50 tokens, another 4,000. With `cost`, a limiter meters *units of work* instead of requests. The rule, for all five algorithms: **a request of cost N is admitted only if N requests of cost 1 in a row would all be admitted.** So every algorithm keeps its guarantees, just counted in units. Details:
- **All or nothing.** A denied request charges nothing. Charging part of it would punish the client for a request that never ran.
- **Whole numbers only.** `cost` must be a positive integer (`resolveCost` throws otherwise). With fractions, "N requests of cost 1" stops being exact for the window algorithms.
- **`retryAfterMs` means "waiting helps".** When it's absent on a denial, the cost is bigger than the whole limit, so no amount of waiting will let it through. The HTTP layer turns that into `413 Content Too Large` instead of `429`, so the client knows not to retry.
- **Tested against a definition, not against itself.** The sliding log is checked against a brute-force "sum of costs in the last window", GCRA against the token bucket with random costs, and the Lua script against the in-memory bucket on 300 random costs.

**Why units are in the names (`resetMs`, `retryAfterMs`).** HTTP headers use seconds and JavaScript uses milliseconds. Putting the unit in the name prevents the classic "off by 1000×" bug.

**Why the core package has no I/O and no dependencies.** It's pure logic, so it's easy to test, reuse and publish to npm.

### 2.1 Fixed window (`fixed-window.ts`)

**Idea.** Cut time into windows, for example each minute. Count requests in the current window, and allow while count < limit.

**State per key.** `{ windowStart, count }`. Two numbers.

**The flaw: boundary burst.** With a limit of 100 per minute, a client sends 100 at 12:00:59 and 100 at 12:01:00. Both windows are "within limit", but that's 200 requests in 2 seconds. The test `FAILURE MODE: lets 2x the limit through across a window boundary` shows it, and the accuracy experiment measures exactly **2.00×** on adversarial traffic.

**When it's fine.** Coarse quotas ("10,000 per day") where a burst at midnight doesn't matter.

### 2.2 Sliding window log (`sliding-window-log.ts`)

**Idea.** Store the timestamp of every admitted request. To decide, drop timestamps older than `now - window`, then count what's left.

**Why it matters here.** It's **exact**: it *is* the definition "at most L in any window W". So the benchmarks use it as the ground truth.

**The cost.** Memory grows with the limit. A limit of 10,000/hour stores up to 10,000 timestamps per client.

### 2.3 Sliding window counter (`sliding-window-counter.ts`)

**Idea (Cloudflare's).** Keep only two counters: the previous window's count and the current one's. Estimate the sliding count by assuming the previous window's requests were spread evenly:

```
estimate = previous × (time left of the previous window that still overlaps) / window + current
         = previous × (W − elapsed) / W + current
```

**Example (from Cloudflare's blog, and a unit test).** Limit 50/min, previous minute 42, current minute 18, 15 s into this minute. The estimate is 42 × 45/60 + 18 = **49.5**. Since 49.5 < 50, the request is allowed (current becomes 19). The next request sees 42 × 45/60 + 19 = 50.5 and is denied.

**Rule:** allow if `estimate < limit`.

**The trade-off.** It's exact when the previous window really was evenly spread, and wrong when it wasn't:
- **Back-loaded previous window** (all requests at its end): the requests are recent, but the formula discounts them, so it **over-admits**. Measured peak: 1.59× on bursty traffic.
- **Front-loaded previous window** (all at its start): the requests are old and arguably shouldn't count, but the formula still counts them, so it **falsely denies**. Measured: 30% of bursty requests.
- **Light traffic:** 0% error, because the algorithms only disagree near the limit. That's why Cloudflare's measured 0.003% error rate is real *for their traffic*. It's a property of the traffic, not a guarantee.

**`retryAfter` solver.** When denied, we solve the formula for the time `e` when the estimate drops below the limit: `previous × (W − e)/W + current < limit`. If `current` alone is already ≥ the limit, we must wait for the next window, where `current` becomes the decaying `previous`.

### 2.4 Token bucket (`token-bucket.ts`)

**Idea.** Each client has a bucket of up to `capacity` tokens, refilled continuously at `refillPerSecond`. Each request takes one token; no token, no service.

**State per key.** `{ tokens, lastRefill }`. Refill is computed lazily on each request, so no background timer is needed:

```
tokens = min(capacity, tokens + (now − lastRefill) × rate)
```

**Why it's the default for the distributed store.** It allows **bursts** up to `capacity` (good for real clients, such as page loads that fire 10 requests at once) while enforcing a long-term average rate. It's used by AWS API Gateway, Stripe and NGINX's `limit_req`, the latter via the equivalent leaky bucket.

**`tokenBucketStep()`.** The math is a separate pure function. Both the in-memory limiter *and* the naive Redis limiter call it. So in the race experiment, the naive and in-memory versions run *identical* arithmetic, and the only difference is atomicity. That's what makes it a controlled experiment.

**EPSILON = 1e-6.** Floating point: `0.1 + 0.2 = 0.30000000000000004`. After thousands of refills, a bucket that should hold exactly 1 token may hold 0.9999999999. We treat "within 1e-6 of a whole token" as a whole token. I first used 1e-9, and the GCRA equivalence test found a failure at rate 7/s after 8,605 requests. 1e-6 is still far smaller than any real token fraction at millisecond timestamps.

### 2.5 GCRA (`gcra.ts`)

**Idea.** The Generic Cell Rate Algorithm, from ATM networks; Redis's `redis-cell` module uses it. Instead of counting tokens, store **one timestamp**, the TAT (theoretical arrival time): when the client would be "caught up" if it sent at exactly the allowed rate.
- emission interval `T = 1 / rate`
- allow if `now ≥ TAT − burst × T`; then `TAT = max(TAT, now) + T`

**Why include it.** It makes the **same decisions** as a token bucket (a unit test checks this on thousands of random requests across 4 configurations), but stores 1 number instead of 2. That's the kind of insight interviewers like: two descriptions of the same mathematical object.

---

## Part 3: going distributed (`packages/redis`)

### 3.1 The broken version, on purpose (`naive-token-bucket.ts`)

```
1. HMGET bucket tokens ts              ← read
2. tokenBucketStep(...) in JavaScript  ← decide
3. MULTI; HSET ...; PEXPIRE ...; EXEC  ← write
```

**The race (check-then-act).** Two requests arrive together. Both read `tokens = 1`. Both decide "allowed" and both write `tokens = 0`. Two requests were admitted for one token. With 50 concurrent clients every request gets through: **20× the limit** (results/race.json).

**"But I used MULTI, isn't that a transaction?"** `MULTI` only makes the *writes* atomic with each other. The *decision* was made in step 2 on data read in step 1, before the transaction started. The fix with plain commands would be `WATCH` + retry (optimistic locking), but under contention most attempts fail and retry. That's more round trips exactly when load is highest.

This file is kept in the codebase as the "before" picture, with a ⚠️ DELIBERATELY BROKEN comment explaining why.

### 3.2 The fix: one Lua script (`lua/token-bucket.lua`, `redis-token-bucket.ts`)

Redis runs a Lua script **to completion before running any other command**, because it's single-threaded for commands. So read, refill, decide and write inside a script is one indivisible step. No other client can sneak in between, and the race is impossible by construction.

Details worth knowing:

- **Same math as the core.** The script mirrors `tokenBucketStep()`, and a test checks that both make the same decisions on the same sequence.
- **Redis's clock (`redis.call('TIME')`).** If each app passed its own `Date.now()`, an app whose clock runs 50 ms fast would refill tokens early. Using Redis's clock means one clock and one truth. Since Redis 5, scripts replicate their *effects*, not the script itself, so calling `TIME` inside a script is allowed. Tests can still pass an explicit `now` argument for determinism.
- **"Absent = full."** After each call the key's TTL is set to the time until the bucket would be full again. A full bucket carries no information, so Redis deletes it. Idle clients cost **zero memory** with no cleanup job. If a key is missing, the script treats it as full.
- **`%.17g` when storing tokens.** Lua's `tostring` keeps only 14 significant digits; 17 is enough to round-trip any double exactly.
- **`EVALSHA` with an `EVAL` fallback (`lua-script.ts`).** The script is sent once and then called by its SHA1 hash, which saves bandwidth. If Redis restarted and forgot it (`NOSCRIPT` error), we resend it with `EVAL`.
- **One round trip instead of two.** It's faster *and* correct: p50 0.88 ms vs 3.3 ms for the naive version.
- **`want` and `need` arguments.** The script grants up to `want` tokens but never fewer than `need` (if it can't give `need`, it gives nothing). A weighted request asks for `want = need = cost`, all or nothing. Leasing asks for a batch but accepts a smaller one. One script serves both.

### 3.3 Token leasing, the extension (`leased-token-bucket.ts`)

**Problem.** Even the atomic version costs one Redis round trip per request. At very high traffic, Redis becomes the bottleneck and every request pays network latency.

**Idea.** An app borrows a batch of tokens (say 20) in one call, then serves the next 19 requests from local memory with no network. It's like a bank teller taking a bundle of cash from the vault instead of walking to the vault for each customer.

**Mechanics:**
- **Single-flight.** If 100 requests miss at the same moment, only *one* Redis call is made, and the other 99 wait for it (the `inflight` map).
- **Lease TTL.** Unused leased tokens are thrown away after `leaseTtlMs`, so an instance can't hoard tokens indefinitely.
- **Denial cache.** When Redis says "empty, retry in 30 ms", the instance denies locally for 30 ms. This is safe because the bucket can't refill sooner than that. With weighted costs the cached time is scaled: a cheaper request could succeed earlier, a bigger one later.
- **Weighted requests.** A request is served from the lease only if the lease holds its whole cost. Otherwise the instance borrows `max(leaseSize, cost)` tokens with `need = cost`.

**What it costs (the trade-off, measured):**
- **False denials.** Tokens sitting in app1's lease are invisible to app2, so app2 may be denied while app1 holds spare tokens. Measured at 0.8% of requests with lease 50 (the whole bucket); 0% at 20 and below.
- **Bounded over-admission.** Tokens borrowed before a refill can be spent after it. The worst case is `instances × leaseSize` extra within one TTL. Not observed in practice.
- **Lost tokens.** Expired leftovers are discarded, never returned.

**What it gains:** 18× fewer Redis calls below the limit (lease 20), and median decision latency of ~0.01 ms.

**Interesting finding.** At saturation, leasing stops helping. The bucket refills one token every 10 ms, so each borrow gets ~1 token, and batches can't form. The denial cache recovers about half the calls.

This is the classic distributed-systems trade-off: **coordination vs accuracy**. Google's Doorman and Envoy's global rate limiting with local token buckets make the same choice.

### 3.4 The Redis client (`client.ts`)

ioredis's defaults are built for "never lose a command": while Redis is unreachable it **queues** commands and retries each one up to 20 times. For a cache that's fine; for a limiter it's the worst outcome. The request is neither allowed nor denied; it just *hangs*. The failover experiment measured requests held for **up to 3.1 s**.

Our settings:

| Setting | Value | Why |
|---|---|---|
| `commandTimeout` | 250 ms | Give up on any single command. |
| `maxRetriesPerRequest` | 1 | Don't stack retries on a request that's already waiting. |
| `enableOfflineQueue` | false | While disconnected, fail immediately instead of queuing. |
| `retryStrategy` | backoff to 1 s | Keep reconnecting in the background. |
| `lazyConnect` | true | The app starts even if Redis isn't up yet; requests take the fail-mode path until it is. |

---

## Part 4: the HTTP layer (`packages/http`)

A limiter only answers "allowed or not". Turning that answer into an HTTP response is the same work in every framework: headers, status code, a timeout, and what to do when Redis is down. So that work lives in one function, and each framework adapter is a thin wrapper of 20 to 40 lines.

### 4.1 One decision function (`check.ts`)

`createCheck(options)` returns `check(key, { cost, context })`, which resolves to a `Decision`. For each request:

1. **Pick the limiter.** One for everyone, or a function `(key, context) => limiter` for tiers or per-route limits.
2. **Decide, with a timeout.** If the limiter returns a Promise (Redis, or the service client), it races a timer (default 200 ms), because a hanging limiter is worse than a failing one. In-memory limiters answer synchronously and can't hang, so they skip the timer.
3. **Headers.**
   - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (seconds until full, following the IETF draft's delta-seconds; GitHub uses an epoch timestamp instead).
   - On a 429, `Retry-After` (RFC 9110), rounded *up* and at least 1. Rounding down would tell clients to come back too early, and they'd be denied again.
4. **Status.** `429 Too Many Requests` when waiting helps. `413 Content Too Large` when the request's cost is bigger than the whole limit, so retrying is pointless (see "Weighted cost" in Part 2).
5. **Failure policy.**
   - `failMode: 'open'`: let the request through, but mark it `X-RateLimit-Status: degraded`.
   - `failMode: 'closed'`: return `503`.
   - An `onError` hook is provided for logging.
6. **Record it** in the metrics: outcome, latency and cost (4.4).

Two rules worth noticing:
- **The decision is data, not a response.** `check()` returns `{ allowed, headers, rejection: { status, body } }` and never touches a framework object. That's why it can be tested without a server, and why every adapter can reuse it.
- **A bug isn't an outage.** An invalid cost (say `-1` from a buggy cost function) throws instead of being treated as a store failure. Under fail-open, treating it as one would silently switch the limit off.

**Choosing fail-open vs fail-closed:** what's worse, a short window without limits, or a short outage?
- **Typical API:** fail-open. The limiter shouldn't turn a Redis hiccup into downtime.
- **Login, password reset, SMS, a paid API:** fail-closed. An unprotected window there could mean brute-force attempts or a large bill.

### 4.2 The adapters (`express.ts`, `fastify.ts`, `hono.ts`, `fetch.ts`)

Each adapter reads the key and cost from the request, calls `check`, sets the headers, then either rejects or continues. They're published as subpaths (`@fluxgate/http/express`, `/fastify`, `/hono`, `/fetch`), so importing the Hono adapter never loads Express, and the frameworks are optional peer dependencies.

Each framework had one trap:
- **Express.** The default key is `key:<x-api-key>` if the header is present, else `ip:<client ip>`. The prefixes keep an API key that looks like an IP from colliding with a real IP, and keys are capped at 128 characters, so a client can't make us store megabyte-sized Redis keys. A bug in a key or cost function goes to `next(err)`, Express's error handler, instead of crashing the process.
- **Fastify.** The same function works as an `onRequest` hook (cheapest: before the body is parsed) or a `preHandler` hook (after parsing). Use `preHandler` when the cost depends on the body, for example an LLM request's `max_tokens`.
- **Hono.** Headers set on the context *before* `next()` are lost when the handler returns its own `Response`. The adapter sets them *after* `next()`.
- **Fetch API (Next.js, Bun, Deno, Cloudflare Workers).** A `Response` from `Response.redirect()` or `fetch()` has immutable headers, and setting one throws. The adapter tries, and on failure copies the response (`new Response(body, res)`) and sets the headers on the copy.

All four adapters run the same three scenarios in one parametrised test (`describe.each`), so they can't drift apart.

### 4.3 Tiers (`tiers.ts`)

`byTier({ tiers: { free, pro }, tierOf, fallback })` returns the function that picks a limiter per request. It throws at startup if the fallback tier doesn't exist, rather than on the first request. Each tier has its own Redis key prefix (`fluxgate:free:` / `fluxgate:pro:`), so the same client upgraded to pro starts a fresh bucket. The demo rule treats keys starting with `pro_` as pro. In production, `tierOf` would look the key up in a database or cache.

### 4.4 Metrics (`metrics.ts`)

`GET /metrics` serves Prometheus' text format, written from scratch (no `prom-client`):

| Metric | Type | Labels | Answers |
|---|---|---|---|
| `fluxgate_decisions_total` | counter | `limiter`, `outcome` | How many requests were allowed, denied, degraded or unavailable? |
| `fluxgate_cost_units_total` | counter | `limiter`, `outcome` | How many units (e.g. LLM tokens) were asked for? |
| `fluxgate_limiter_duration_seconds` | histogram | `limiter` | How long do decisions take? |
| `fluxgate_redis_calls_total` | counter | `policy` | How much load do we put on Redis? (server only) |

Decisions:
- **Never label by client.** Every label combination is a separate time series that Prometheus stores. One per API key would be millions of series (a "cardinality explosion"), which can take the monitoring system down. The labels here are bounded sets: limiter names and four outcomes. Per-client detail belongs in logs.
- **Zero-initialised series.** Every outcome is written as 0 at startup (`declare`). Otherwise `denied` would only appear after the first denial, and queries and alerts would see "no data" instead of 0.
- **A histogram, not an average.** Averages hide the tail, and the tail is what users feel. The buckets span 50 µs (in-memory) to 1 s (past any sane timeout).
- **Read, don't double count.** The Redis limiters already count their calls (`.calls`), so the server registers a counter with a read function that runs at scrape time.
- **The format details matter.** Label values escape `\`, `"` and newlines. Histogram buckets are cumulative and end with `+Inf`. A test checks every line of the output against the format's grammar.

---

## Part 5: service mode (`packages/server/src/service.ts`, `packages/client`)

**Problem.** In-process limiting needs every app to be written in Node, to hold a Redis connection, and to be redeployed to change a limit. That doesn't fit a Python service, an edge function that can't open TCP connections, or a team that wants all limits managed in one place.

**Idea.** Run FluxGate as a service, the way Envoy's global rate-limit service works. Apps ask it over HTTP:

```http
POST /v1/check
Authorization: Bearer <token>

{ "policy": "free", "key": "user-42", "cost": 1 }
```
```http
200 OK

{ "allowed": true, "limit": 20, "remaining": 19, "resetMs": 500 }
```

Contract choices:
- **A denial is still `200`.** The status describes the call to the service, which succeeded. The decision is in the body. If denials were `429`, a client couldn't tell "your user is limited" from "the rate-limit service is overloaded".
- **Errors map to what the caller can act on.** `400` for bad input (`unknown_policy` lists the valid names), `401` for a missing or wrong token, `503` when the store is down.
- **The service always fails closed; the caller decides.** When Redis is down, the service answers `503` rather than guessing. The calling app knows whether it's protecting a login form (reject) or a product page (let through), so *its* `failMode` applies.
- **Named policies.** `POLICIES='{"free":{"capacity":20,"refillPerSecond":2},...}'`. Changing a limit is a config change in one place, not a redeploy of every app.
- **The token is compared in constant time.** A normal string comparison stops at the first differing character, so response timing can leak how much of a guessed token is right. Both values are hashed with SHA-256 (so their lengths are equal) and compared with `crypto.timingSafeEqual`.
- **Bounded input.** 4 KB bodies, keys of at most 256 characters, costs that are positive integers.

**The client (`@fluxgate/client`).** `new FluxgateClient({ url, token }).policy('free')` returns an object with the same `consume()` as every limiter. So it plugs into every adapter unchanged, and the adapter's timeout and fail-open/closed policy cover the network call too. The client has its own 100 ms default timeout, throws a typed `FluxgateServiceError` for timeouts, network errors, non-2xx answers and malformed bodies, and uses only `fetch`, so it runs in edge runtimes.

**What it costs.** One HTTP hop per decision. `bench/service.ts` measures it against in-process limiting and against a bare `node:http` server that does no work at all, the floor for any HTTP service on the same machine. On this machine (Windows loopback, one client process):
- **In-process, the HTTP layer is free.** `check()` with its timeout, headers and metrics is indistinguishable from a bare `consume()`: well under a microsecond in memory, and the same ~1 ms as the Redis round trip itself.
- **The service costs one HTTP hop, and almost nothing more.** The bare server answers at p50 0.9 ms; the service with an in-memory store at 1.3 ms. At 64 in flight both top out around 1,300 decisions/s, a ceiling set by the client process and the loopback, not by FluxGate.
- **Behind the service, the store is the second hop.** With `redis-lua` every decision is HTTP *plus* a Redis round trip (p50 3.0 ms). With `redis-leased` the service answers from its lease (p50 1.1 ms, back at the floor) and makes 0.05 Redis calls per decision.

So the trade is explicit: service mode buys language independence and central policies for about one millisecond per decision. When that millisecond matters, use the in-process adapters with Redis directly.

---

## Part 6: the app (`packages/server`)

`app.ts`, `main.ts`, `limiters.ts` and `policies.ts` assemble the pieces into the deployable server: a demo API, the service, and `/metrics`.

- **`/health` and `/metrics` are mounted before the limiter.** Load balancers poll health checks; if they were rate limited, a busy-but-healthy instance would be marked dead and removed. That's a cascading failure. Prometheus scrapes `/metrics` every few seconds for the same reason.
- **`X-Instance-Id` header** lets you watch Nginx rotate between app1, app2 and app3.
- **`trust proxy`.** Behind Nginx, `req.ip` is Nginx's address for *every* request, which would put the whole internet under one limit. With `trust proxy = 1`, Express reads the client IP from `X-Forwarded-For`. It must be exactly **1** (the number of proxies we control):
  - A client can send its own fake `X-Forwarded-For: 1.2.3.4`.
  - Nginx *appends* the real address, so the header becomes `1.2.3.4, <real ip>`.
  - Express with `trust proxy = 1` takes the right-most entry, the one Nginx wrote.
  - With `trust proxy = true`, it would take the left-most, forged one, and an attacker could pick a new IP on every request to dodge the limit.
- **Configuration via environment variables (12-factor).** `STORE`, `FAIL_MODE`, `POLICIES`, `SERVICE_TOKEN` and others, so Docker Compose can switch the store without code changes. Invalid values fail at startup, not at request time. Without `SERVICE_TOKEN`, the server logs a warning that anyone who can reach it can use `/v1/check`.
- **One limiter per policy, shared.** The demo API (`/api/*`) and the service (`/v1/check`) use the same policy objects, so a client's budget is the same whichever way it arrives.
- **`npx @fluxgate/server`.** The package has a `bin`, so the service runs without Docker too.
- **Graceful shutdown.** On `SIGTERM` (sent by Docker on `docker compose down`): stop accepting connections, finish in-flight requests, close Redis, and force-exit after 5 s.

---

## Part 7: deployment (`docker/`, `docker-compose.yml`, `k6/`)

- **Dockerfile, multi-stage.**
  - The build stage installs everything and compiles TypeScript.
  - The runtime stage copies only `dist/` and production dependencies (`npm prune --omit=dev`), which makes a smaller image with no compiler inside.
  - It runs as the non-root `node` user and has a `HEALTHCHECK`.
- **Compose.**
  - Redis has no persistence, on purpose. Limiter state is short-lived: keys expire as buckets refill, so after a restart everyone simply gets a full bucket.
  - The three app services share one YAML anchor, so they can't drift apart.
- **Nginx.**
  - Plain round-robin. It knows nothing about rate limiting, which is the point: the apps are stateless, so any app can serve any request.
  - `keepalive 64` reuses connections to the apps instead of opening a TCP connection per request.
  - Nginx answers `403` for `/metrics`. Traffic levels and denial rates are internal information; Prometheus reaches the apps directly on the Compose network.
- **Observability (`--profile observability`).** Prometheus and Grafana, both version-pinned, only start when asked for, so the default stack stays small.
  - Prometheus scrapes each app *directly* every 5 s. Scraping through Nginx would land on a random instance each time and mix their counters.
  - Grafana is provisioned from files (`docker/grafana/`): the data source and the FluxGate dashboard exist at startup, with no clicking. Anonymous users get read-only access, which is fine on localhost and must be changed anywhere else.
  - The dashboard answers the on-call questions in order: Is traffic flowing? How much is denied? Is the store failing? How slow are decisions? Then breakdowns by outcome, instance, limiter and policy, plus cost units and Redis load. A `limiter` variable filters every panel.
- **k6.** Sends a *constant arrival rate* (open loop) through Nginx and counts 200s per instance. The test passes when the global total ≈ `capacity + rate × seconds`, wherever the requests landed.

---

## Part 8: the evaluation (`packages/bench`)

Six experiments. Each writes `results/<name>.json`, and `report.ts` turns the JSON into the tables and charts in README.md and REPORT.md, so no number in the docs was typed by hand.

| Script | Question | Headline |
|---|---|---|
| `race.ts` | How badly does non-atomic over-admit? | 20× at ≥ 50 concurrent clients; Lua exactly 1× |
| `accuracy.ts` | How wrong are the cheap algorithms? | Exact when light; sliding counter 1.59× peak / 30% false deny on bursts; fixed window 2× |
| `latency.ts` | What does a decision cost? | memory ~1 µs; Lua 0.9 ms; naive 3.3 ms; leased mostly local |
| `service.ts` | What do the HTTP layer and service mode cost? | `check()` + metrics: not measurable; service: one HTTP hop (~1 ms), at the bare-server floor |
| `leasing.ts` | Accuracy vs Redis calls? | 18× fewer calls below the limit; benefit shrinks at saturation |
| `failover.ts` | What happens when Redis freezes? | defaults: hang up to 3.1 s; tuned: p99 ~115 ms with explicit policy |

**Method choices worth defending:**
- **Open-loop load.** Requests are sent on a schedule regardless of responses. A closed loop (send, wait, send) automatically slows down when the server slows down, which hides latency problems. This is "coordinated omission", a well-known benchmarking mistake.
- **Seeded random numbers (`mulberry32`).** Every run of the accuracy experiment produces identical traffic.
- **Judging accuracy against each limiter's own history.** Comparing request-by-request with the exact log would be misleading under overload: two limiters may admit the same *number* of requests but *different individual* requests. So we ask, at each decision: "given what *this* limiter already admitted in the last window, was this decision right?"
- **`docker compose pause` instead of `stop` for failover.** Stopping closes the connection and ioredis notices instantly. Pausing freezes the process with the TCP connection still open, so nothing errors and requests just hang. That's the realistic, nasty case: a GC pause, a stuck disk, a network partition.
- **Async `docker` calls.** The benchmark runs `docker compose pause` without blocking Node's event loop. A blocking call would have frozen our own load generator and distorted the measurement.

---

## Part 9: known limitations (say these before the interviewer does)

1. **Redis is a single point of failure.** Fail-open/closed handles the *consequence*, not the cause. Production would use Redis Sentinel (failover) or Cluster (sharding). In Cluster, a script must only touch keys in one hash slot. Ours touches exactly one key, so it already works.
2. **In-memory limiters never delete idle keys.** Their Maps grow with the number of distinct clients. Fine for benchmarks; production needs an LRU or a periodic sweep. The Redis stores don't have this problem, thanks to TTLs.
3. **Benchmarks ran on a Windows laptop with Docker Desktop.** Absolute latencies are inflated by virtualised networking, so compare relative numbers.
4. **The service is another dependency.** Service mode adds a network hop and a process that can fail. It's stateless, so you can run several replicas behind a load balancer, and the caller's `failMode` decides what happens when none answer. It doesn't batch or cache decisions on the caller's side yet.
5. **No `RateLimit-Policy` header.** The IETF draft's newer `RateLimit` / `RateLimit-Policy` fields aren't emitted; the widely used `X-RateLimit-*` ones are.

---

## Part 10: interview questions and answers

**Q: Why not just use `express-rate-limit` with a Redis store?**
Using a library would be the right production choice. The goal here was to understand *why* those libraries are built the way they are: to reproduce the race they avoid, measure the error of the algorithms they choose, and test their failure behaviour. Several findings are things a library's README doesn't tell you, such as the default ioredis client hanging requests for seconds during an outage.

**Q: Explain the race condition in one sentence.**
Two requests read the same counter before either writes it back, so both see room for one more and both get admitted. It's check-then-act on shared state without atomicity.

**Q: Why does MULTI/EXEC not fix it?**
MULTI makes the writes atomic, but the decision was made earlier on a stale read. You'd need WATCH with optimistic retry, which under contention means many retries. A Lua script makes read, decide and write a single step on the server.

**Q: Isn't a Lua script blocking Redis?**
Yes. While it runs, nothing else does. That's why it must be short: ours is a few hash operations, O(1), microseconds. Long scripts are a real anti-pattern. Ours does constant work regardless of traffic.

**Q: Why use Redis's clock?**
App servers' clocks drift. If each app passed its own time, a fast clock would refill tokens early and a slow one would see time going backwards. Redis's `TIME` gives one consistent clock for all instances. As a safety net, the script also clamps elapsed time to ≥ 0.

**Q: Token bucket vs sliding window: which would you choose?**
It depends on the contract:
- **Token bucket:** for "average rate with bursts allowed" (most APIs).
- **Sliding log:** for "never more than N in any window", and only if the limit is small enough to store timestamps.
- **Sliding counter:** for a cheap, close approximation when traffic is mostly below the limit. Our measurements show it's exact under light load and noticeably wrong under bursty overload.

**Q: What's GCRA and why is it the same as the token bucket?**
GCRA stores the theoretical arrival time instead of a token count. "Tokens remaining" equals how far TAT is behind `now + burst × interval`, divided by the interval. It's the same quantity, stored differently. It needs 1 number per key instead of 2, and the unit test confirms identical decisions.

**Q: What happens if Redis goes down?**
The Redis client fails fast (250 ms command timeout, no offline queue) and `check()` has its own timeout. Then the configured policy applies: fail-open serves the request with a `degraded` header, fail-closed returns 503. With library defaults, our measurement showed requests hanging for up to 3 s, which is worse than either policy.

**Q: How would you scale this to millions of clients?**
- **Redis Cluster** sharded by client key. Each script touches one key, so it's cluster-safe.
- **Token leasing** for hot keys, to cut per-request Redis calls.
- **A local cache of denials**, which is already implemented in the leased store.
- **A two-level design for global limits across regions:** a per-region limiter with a periodically reconciled global budget, accepting bounded inaccuracy.

**Q: What's the trade-off of token leasing?**
Fewer Redis calls in exchange for precision:
- Tokens held by one instance can't be used by another, which causes false denials.
- Tokens borrowed before a refill can be spent after it, which allows bounded over-admission.

The lease size is the knob. At 20 we measured 18× fewer calls and no false denials; at 50 (the whole bucket), 0.8% false denials.

**Q: How do you get the client's IP behind a load balancer, and what's the security risk?**
From `X-Forwarded-For`, trusting exactly as many hops as proxies you control. Clients can forge that header, but our Nginx appends the real address. Express with `trust proxy = 1` reads the right-most entry, the one Nginx wrote. Trusting all hops would let attackers choose their own IP on every request.

**Q: Why is `/health` not rate-limited?**
The load balancer would mark a busy-but-healthy instance as dead, shift its traffic to the others, overload those, and cascade.

**Q: Why open-loop load generation?**
In a closed loop, a slow server makes the client send less, so the measured latency looks better than users would experience. That's coordinated omission. An open loop sends on schedule, like independent users do.

**Q: How do weighted costs work, and what if a request costs more than the limit?**
A cost-N request is admitted only if N cost-1 requests in a row would be, so every algorithm keeps its guarantee, counted in units instead of requests. Denied requests charge nothing. If N is bigger than the whole limit, no amount of waiting helps, so the limiter returns no `retryAfterMs` and the HTTP layer answers `413` instead of `429`. A client that retries on 429 would otherwise loop forever.

**Q: In service mode, why is a denied request a 200?**
The HTTP status describes the call to the rate-limit service, and that call worked. The decision is data in the body. If denials were 429, the caller couldn't tell "your user is over the limit" from "the rate-limit service is overloaded", and those need opposite reactions.

**Q: Why not label metrics by API key? That would be useful.**
Every label combination is its own time series. A label per key means one series per customer, which can be millions, and that's the classic way to take down Prometheus. Metrics answer "how is the system doing?" with bounded labels (limiter, outcome). "What did customer X do?" is a question for logs.

**Q: Why write the Prometheus format by hand instead of using `prom-client`?**
It's a small, stable text format, and the project's rule is no shortcuts in the core path. Doing it by hand meant learning the parts that matter: cumulative histogram buckets, `+Inf`, label escaping, and initialising series to 0 so alerts don't see "no data". A test validates every output line against the format.

**Q: What would you do next?**
- Redis Cluster support, plus tests for a cluster failover (buckets resetting).
- The IETF `RateLimit` / `RateLimit-Policy` headers.
- Client-side batching or local leasing in `@fluxgate/client`, so service mode can skip the hop for hot keys, the same idea as token leasing one level up.
- A larger evaluation on Linux, with separate machines for client, app and Redis.
