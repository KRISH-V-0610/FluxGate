# @fluxgate/server

FluxGate as a deployable service: `POST /v1/check` with named policies, `GET /metrics` for Prometheus, and `GET /health`. Configure it with environment variables and call it from any language.

```bash
STORE=redis-leased REDIS_URL=redis://localhost:6379 SERVICE_TOKEN=s3cret \
POLICIES='{"free":{"capacity":20,"refillPerSecond":2},"login":{"capacity":5,"refillPerSecond":0.1}}' \
npx @fluxgate/server
```

```bash
curl -s localhost:3000/v1/check -H 'authorization: Bearer s3cret' \
  -H 'content-type: application/json' -d '{"policy":"login","key":"ip:203.0.113.7"}'
# {"allowed":true,"limit":5,"remaining":4,"resetMs":10000}
```

| Variable | Default | Meaning |
|---|---|---|
| `STORE` | `redis-lua` | `memory`, `redis-lua` or `redis-leased` (`redis-naive` exists for the race benchmark only) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Where Redis is |
| `POLICIES` | `free` and `pro` demo tiers | JSON: `{"name": {"capacity": n, "refillPerSecond": r}}` |
| `SERVICE_TOKEN` | none (logs a warning) | Required as `Authorization: Bearer <token>` on `/v1/check` |
| `PORT` | `3000` | |
| `LIMITER_TIMEOUT_MS` | `200` | A slower store counts as failed |
| `FAIL_MODE` | `open` | What the demo API does when the store fails. `/v1/check` answers `503` and lets the caller decide. |
| `LEASE_SIZE`, `LEASE_TTL_MS` | `5`, `1000` | For `redis-leased` |
| `TRUST_PROXY` | unset | Proxy hops to trust for the client IP, e.g. `1` behind Nginx |

A denied request is still `200`, with the decision in the body. `400` means bad input or an unknown policy, `401` a wrong token, and `503` that the store is unavailable.

Call it with [`@fluxgate/client`](https://www.npmjs.com/package/@fluxgate/client) or plain HTTP. Part of [FluxGate](https://github.com/KRISH-V-0610/FluxGate#readme), with Docker Compose, Grafana dashboards and measured results. MIT.
