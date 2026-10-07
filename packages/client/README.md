# @flux-gate/client

The client for a FluxGate rate-limit service (`POST /v1/check`). Use it when many apps should share one set of limits, or from runtimes that can't open a Redis connection.

```bash
npm i @flux-gate/client
```

```ts
import { FluxgateClient } from '@flux-gate/client';
import { fluxgate } from '@flux-gate/http/express';

const ratelimit = new FluxgateClient({ url: 'http://ratelimit:3000', token: process.env.FLUXGATE_TOKEN });

// A policy works like a local limiter in any @flux-gate/http adapter.
app.use('/api', fluxgate({ limiter: ratelimit.policy('free'), failMode: 'open' }));

// Or ask directly.
const { allowed, retryAfterMs } = await ratelimit.check({ policy: 'login', key: `ip:${ip}`, cost: 1 });
```

The client has a 100 ms timeout by default. When the service gives no decision (it's unreachable, slow, or its store is down), the client throws `FluxgateServiceError`, so your adapter's fail mode decides what happens. A denial is not an error: it resolves with `allowed: false`.

Run the service with [`@flux-gate/server`](https://www.npmjs.com/package/@flux-gate/server). Part of [FluxGate](https://github.com/KRISH-V-0610/FluxGate#readme). MIT.
