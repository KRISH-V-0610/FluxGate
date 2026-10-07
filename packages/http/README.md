# @fluxgate/http

Rate limiting for any Node web framework. One decision function, `createCheck()`, with adapters for **Express, Fastify, Hono and the Fetch API** (Next.js, Bun, Deno, Cloudflare Workers). You get:

- the standard `X-RateLimit-*` and `Retry-After` headers;
- `429` when a caller is over the limit, and `413` when a request can never fit;
- per-plan tiers;
- a limiter timeout, with fail-open or fail-closed when the store is down;
- Prometheus metrics.

```bash
npm i @fluxgate/http @fluxgate/core     # or @fluxgate/redis for a limit shared across instances
```

```ts
import { TokenBucketLimiter } from '@fluxgate/core';
import { fluxgate } from '@fluxgate/http/express';     // or /fastify, /hono, /fetch

app.use('/api', fluxgate({ limiter: new TokenBucketLimiter({ capacity: 20, refillPerSecond: 2 }) }));
```

```ts
// Next.js route handler, charging by tokens instead of requests
import { withRateLimit } from '@fluxgate/http/fetch';

export const POST = withRateLimit(
  { limiter, key: (req) => req.headers.get('x-api-key') ?? 'anonymous', cost: async (req) => (await req.clone().json()).max_tokens },
  handler,
);
```

The framework is a peer dependency: install the one you use. More examples (tiers, Hono, metrics, no framework) are in the [main README](https://github.com/KRISH-V-0610/FluxGate#use-it-in-your-app).

Part of [FluxGate](https://github.com/KRISH-V-0610/FluxGate#readme). MIT.
