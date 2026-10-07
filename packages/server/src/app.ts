import express, { type Express } from 'express';
import { fluxgate, type FluxgateOptions } from './middleware.js';
import { demoTierOf } from './tiers.js';

export interface AppOptions extends FluxgateOptions {
  /** Shown in every response so you can watch Nginx rotate across instances. */
  instanceId?: string;
  /**
   * Behind Nginx, req.ip would be Nginx's IP for everyone (one shared limit
   * for the whole internet). 'trust proxy' makes Express read the client IP
   * from X-Forwarded-For instead. Only enable it behind a proxy you control,
   * because otherwise clients can forge that header to dodge the limit.
   */
  trustProxy?: boolean | number;
}

export function createApp(options: AppOptions): Express {
  const instance = options.instanceId ?? 'local';
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Instance-Id', instance);
    next();
  });

  // Health checks must never be rate limited, or the load balancer would
  // mark a healthy instance as dead whenever it's busy.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', instance });
  });

  app.use('/api', fluxgate(options));

  app.get('/api/hello', (req, res) => {
    const key = req.get('x-api-key');
    res.json({ message: 'hello from FluxGate', instance, tier: key ? demoTierOf(`key:${key}`) : 'free' });
  });

  return app;
}
