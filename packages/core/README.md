# @flux-gate/core

Five rate-limiting algorithms as pure, synchronous, zero-dependency classes: **fixed window, sliding window log, sliding window counter, token bucket and GCRA.** Every one supports weighted cost and takes an injectable clock, so tests are deterministic.

```bash
npm i @flux-gate/core
```

```ts
import { TokenBucketLimiter } from '@flux-gate/core';

const limiter = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 2 });
const result = limiter.consume('user:42');               // { allowed, limit, remaining, resetMs, retryAfterMs? }
const big = limiter.consume('user:42', { cost: 5 });     // a request that uses 5 units
```

For one server. To share a limit across instances, use [`@flux-gate/redis`](https://www.npmjs.com/package/@flux-gate/redis); to put it in front of a web framework, use [`@flux-gate/http`](https://www.npmjs.com/package/@flux-gate/http).

Part of [FluxGate](https://github.com/KRISH-V-0610/FluxGate#readme), which has the design notes and measured results. MIT.
