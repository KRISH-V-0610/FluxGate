import express, { type Express } from 'express';
import type { Metrics } from '@flux-gate/http';
import { fluxgate, type ExpressOptions } from '@flux-gate/http/express';
import { createServiceRouter, type ServiceOptions } from './service.js';
import { demoTierOf } from './tiers.js';

export interface AppOptions extends ExpressOptions {
  /** Shown in every response so you can watch Nginx rotate across instances. */
  instanceId?: string;
  /**
   * Behind Nginx, req.ip would be Nginx's IP for everyone (one shared limit
   * for the whole internet). 'trust proxy' makes Express read the client IP
   * from X-Forwarded-For instead. Only enable it behind a proxy you control,
   * because otherwise clients can forge that header to dodge the limit.
   */
  trustProxy?: boolean | number;
  /** Serve GET /metrics for Prometheus, and record every decision in it. */
  metrics?: Metrics;
  /** Serve POST /v1/check so other apps can use these policies (see @flux-gate/client). */
  service?: Omit<ServiceOptions, 'metrics'>;
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

  // Not rate limited either: Prometheus scrapes it every few seconds.
  // Nginx blocks it from the outside (docker/nginx.conf).
  const metrics = options.metrics;
  if (metrics) {
    app.get('/metrics', (_req, res) => {
      // end(), not send(): send() rewrites the Content-Type parameters.
      res.setHeader('Content-Type', metrics.contentType);
      res.end(metrics.render());
    });
  }

  if (options.service) app.use(createServiceRouter({ ...options.service, metrics }));

  app.use('/api', fluxgate({ name: 'api', ...options }));

  app.get('/api/hello', (req, res) => {
    const key = req.get('x-api-key');
    res.json({ message: 'hello from FluxGate', instance, tier: key ? demoTierOf(`key:${key}`) : 'free' });
  });

  return app;
}
