# @flux-gate/redis

Rate limits shared by every instance of your app, stored in Redis.

- **`RedisTokenBucket`**: read, refill, decide and write in one Lua script, so concurrent requests can't spend the same token. It uses one round trip and Redis's own clock.
- **`LeasedTokenBucket`**: borrows tokens in batches and answers from the local batch, cutting Redis calls by about 18× below the limit.
- **`connectRedis()`**: an ioredis client tuned to fail fast (250 ms command timeout, no offline queue) instead of hanging when Redis freezes.

```bash
npm i @flux-gate/redis
```

```ts
import { connectRedis, RedisTokenBucket } from '@flux-gate/redis';

const redis = await connectRedis({ url: process.env.REDIS_URL });
const limiter = new RedisTokenBucket(redis, { capacity: 20, refillPerSecond: 2, prefix: 'rl:api:' });
const result = await limiter.consume('user:42', { cost: 1 });
```

Pair it with [`@flux-gate/http`](https://www.npmjs.com/package/@flux-gate/http) for Express, Fastify, Hono or Next.js.

`NaiveRedisTokenBucket` is deliberately racy, and it's exported only so the benchmarks can show the race. Don't use it.

Part of [FluxGate](https://github.com/KRISH-V-0610/FluxGate#readme), which has the design notes and measured results. MIT.
