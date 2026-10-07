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
  consume(key: string, now?: number): RateLimitResult;
}
interface RateLimitResult {
  allowed: boolean;
  limit: number;          // for the X-RateLimit-Limit header
  remaining: number;      // for X-RateLimit-Remaining
  resetMs: number;        // ms until the limiter is fully reset
  retryAfterMs?: number;  // only when denied: ms until the next request could succeed
}
```

**Why `now` is a parameter.** Tests can pass exact timestamps (`consume('a', 1000)`, then `consume('a', 1999)`) instead of sleeping or mocking `Date.now()`. That makes every test instant and deterministic, and it makes the accuracy experiment able to simulate 2 hours of traffic in milliseconds.

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
- **`want` argument.** The same script can take *N* tokens at once (it grants `min(N, available)`), which is what leasing needs.

### 3.3 Token leasing, the extension (`leased-token-bucket.ts`)

**Problem.** Even the atomic version costs one Redis round trip per request. At very high traffic, Redis becomes the bottleneck and every request pays network latency.

**Idea.** An app borrows a batch of tokens (say 20) in one call, then serves the next 19 requests from local memory with no network. It's like a bank teller taking a bundle of cash from the vault instead of walking to the vault for each customer.

**Mechanics:**
- **Single-flight.** If 100 requests miss at the same moment, only *one* Redis call is made, and the other 99 wait for it (the `inflight` map).
- **Lease TTL.** Unused leased tokens are thrown away after `leaseTtlMs`, so an instance can't hoard tokens indefinitely.
- **Denial cache.** When Redis says "empty, retry in 30 ms", the instance denies locally for 30 ms. This is safe because the bucket can't refill sooner than that.

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

## Part 4: the HTTP layer (`packages/server`)

### 4.1 The middleware (`middleware.ts`)

`fluxgate(options)` returns an Express middleware. For each request:

1. **Key.** Who is this? By default `key:<x-api-key>` if the header is present, else `ip:<client ip>`.
   - The prefixes keep an API key that looks like an IP from colliding with a real IP.
   - Keys are capped at 128 characters, so a client can't make us store megabyte-sized Redis keys.
2. **Limiter.** One limiter for everyone, or a function choosing one per request (tiers).
3. **Decide, with a timeout.** `await` works for both the synchronous memory limiter and the async Redis ones. It's wrapped in `Promise.race` with a timer (default 200 ms), because a hanging limiter is worse than a failing one.
4. **Headers.**
   - `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (seconds until full, following the IETF draft's delta-seconds; GitHub uses an epoch timestamp instead).
   - On a 429, `Retry-After` (RFC 9110), rounded *up* and at least 1. Rounding down would tell clients to come back too early, and they'd be denied again.
5. **Failure policy.**
   - `failMode: 'open'`: let the request through, but mark it `X-RateLimit-Status: degraded`.
   - `failMode: 'closed'`: return `503`.
   - An `onError` hook is provided for logging and metrics.

**Choosing fail-open vs fail-closed:** what's worse, a short window without limits, or a short outage?
- **Typical API:** fail-open. The limiter shouldn't turn a Redis hiccup into downtime.
- **Login, password reset, SMS, a paid API:** fail-closed. An unprotected window there could mean brute-force attempts or a large bill.

### 4.2 Tiers (`tiers.ts`)

`byTier({ tiers: { free, pro }, tierOf, fallback })` returns the function that picks a limiter per request. Each tier has its own Redis key prefix (`fluxgate:free:` / `fluxgate:pro:`), so the same client upgraded to pro starts a fresh bucket. The demo rule treats keys starting with `pro_` as pro. In production, `tierOf` would look the key up in a database or cache.

### 4.3 The app (`app.ts`, `main.ts`, `limiters.ts`)

- **`/health` is mounted before the limiter.** Load balancers poll health checks; if they were rate limited, a busy-but-healthy instance would be marked dead and removed. That's a cascading failure.
- **`X-Instance-Id` header** lets you watch Nginx rotate between app1, app2 and app3.
- **`trust proxy`.** Behind Nginx, `req.ip` is Nginx's address for *every* request, which would put the whole internet under one limit. With `trust proxy = 1`, Express reads the client IP from `X-Forwarded-For`. It must be exactly **1** (the number of proxies we control):
  - A client can send its own fake `X-Forwarded-For: 1.2.3.4`.
  - Nginx *appends* the real address, so the header becomes `1.2.3.4, <real ip>`.
  - Express with `trust proxy = 1` takes the right-most entry, the one Nginx wrote.
  - With `trust proxy = true`, it would take the left-most, forged one, and an attacker could pick a new IP on every request to dodge the limit.
- **Configuration via environment variables (12-factor).** `STORE`, `FAIL_MODE`, `FREE_CAPACITY` and others, so Docker Compose can switch the store without code changes. Invalid values fail at startup, not at request time.
- **Graceful shutdown.** On `SIGTERM` (sent by Docker on `docker compose down`): stop accepting connections, finish in-flight requests, close Redis, and force-exit after 5 s.

---

## Part 5: deployment (`docker/`, `docker-compose.yml`, `k6/`)

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
- **k6.** Sends a *constant arrival rate* (open loop) through Nginx and counts 200s per instance. The test passes when the global total ≈ `capacity + rate × seconds`, wherever the requests landed.

---

## Part 6: the evaluation (`packages/bench`)

Five experiments. Each writes `results/<name>.json`, and `report.ts` turns the JSON into the tables and charts in README.md and REPORT.md, so no number in the docs was typed by hand.

| Script | Question | Headline |
|---|---|---|
| `race.ts` | How badly does non-atomic over-admit? | 20× at ≥ 50 concurrent clients; Lua exactly 1× |
| `accuracy.ts` | How wrong are the cheap algorithms? | Exact when light; sliding counter 1.59× peak / 30% false deny on bursts; fixed window 2× |
| `latency.ts` | What does a decision cost? | memory ~1 µs; Lua 0.9 ms; naive 3.3 ms; leased mostly local |
| `leasing.ts` | Accuracy vs Redis calls? | 18× fewer calls below the limit; benefit shrinks at saturation |
| `failover.ts` | What happens when Redis freezes? | defaults: hang up to 3.1 s; tuned: p99 ~115 ms with explicit policy |

**Method choices worth defending:**
- **Open-loop load.** Requests are sent on a schedule regardless of responses. A closed loop (send, wait, send) automatically slows down when the server slows down, which hides latency problems. This is "coordinated omission", a well-known benchmarking mistake.
- **Seeded random numbers (`mulberry32`).** Every run of the accuracy experiment produces identical traffic.
- **Judging accuracy against each limiter's own history.** Comparing request-by-request with the exact log would be misleading under overload: two limiters may admit the same *number* of requests but *different individual* requests. So we ask, at each decision: "given what *this* limiter already admitted in the last window, was this decision right?"
- **`docker compose pause` instead of `stop` for failover.** Stopping closes the connection and ioredis notices instantly. Pausing freezes the process with the TCP connection still open, so nothing errors and requests just hang. That's the realistic, nasty case: a GC pause, a stuck disk, a network partition.
- **Async `docker` calls.** The benchmark runs `docker compose pause` without blocking Node's event loop. A blocking call would have frozen our own load generator and distorted the measurement.

---

## Part 7: known limitations (say these before the interviewer does)

1. **Redis is a single point of failure.** Fail-open/closed handles the *consequence*, not the cause. Production would use Redis Sentinel (failover) or Cluster (sharding). In Cluster, a script must only touch keys in one hash slot. Ours touches exactly one key, so it already works.
2. **In-memory limiters never delete idle keys.** Their Maps grow with the number of distinct clients. Fine for benchmarks; production needs an LRU or a periodic sweep. The Redis stores don't have this problem, thanks to TTLs.
3. **Benchmarks ran on a Windows laptop with Docker Desktop.** Absolute latencies are inflated by virtualised networking, so compare relative numbers.
4. **One limit per request.** No per-route limits or weighted costs (e.g. an expensive endpoint costing 5 tokens). The Lua script's `want` argument makes weighted costs a small change.

---

## Part 8: interview questions and answers

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
The client fails fast (250 ms command timeout, no offline queue) and the middleware has its own timeout. Then the configured policy applies: fail-open serves the request with a `degraded` header, fail-closed returns 503. With library defaults, our measurement showed requests hanging for up to 3 s, which is worse than either policy.

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

**Q: What would you do next?**
- Redis Cluster support plus tests for a cluster failover (buckets resetting).
- Weighted request costs.
- The IETF `RateLimit-Policy` header.
- A Prometheus endpoint (admitted, denied, degraded, limiter latency).
- A larger evaluation on Linux with separate machines for client, app and Redis.
