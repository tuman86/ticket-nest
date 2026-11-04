import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { getCorrelationId, type Logger } from '@ticketnest/logger';
import { type DependencyCheck } from '@ticketnest/service-runtime';
import {
  createHealthRouter,
  createRequestLogger,
  handleRequestId,
} from '@ticketnest/service-runtime/express';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';

import { createCorsOptions } from './http/cors-options';

export interface AppDependencies {
  readonly logger: Logger;
  readonly readinessChecks: readonly DependencyCheck[];
  readonly isShuttingDown: () => boolean;
  readonly corsOrigins: readonly string[];
  /** Adds the message and stack to 500 responses. Development only. */
  readonly isDebugInfoExposed: boolean;
  /** Routers mounted after the health endpoints and CORS: in production, the proxy router. */
  readonly routers?: readonly Router[];
  /**
   * How many reverse proxies in front of the service to trust for the client IP
   * (`X-Forwarded-For`). Leave unset or 0 when clients reach the service directly, so no client
   * can choose its own IP; set 1 behind an ALB.
   */
  readonly trustProxyHops?: number;
  readonly checkTimeoutMs?: number;
}

/**
 * Builds the Express app. It opens no sockets and creates no clients, so tests can import it.
 *
 * @param dependencies - The logger, health checks, CORS origins, the routers that carry traffic
 *   and the number of proxy hops to trust for the client IP.
 * @returns The configured app, ready to listen or to hand to Supertest.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { logger, corsOrigins, routers = [] } = dependencies;
  const app = express();
  if (dependencies.trustProxyHops !== undefined) {
    app.set('trust proxy', dependencies.trustProxyHops);
  }

  app.use(handleRequestId);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(cors(createCorsOptions(corsOrigins)));

  app.use(
    createHealthRouter({
      logger,
      readinessChecks: dependencies.readinessChecks,
      isShuttingDown: dependencies.isShuttingDown,
      ...(dependencies.checkTimeoutMs === undefined
        ? {}
        : { checkTimeoutMs: dependencies.checkTimeoutMs }),
    }),
  );
  for (const router of routers) {
    app.use(router);
  }

  app.use(handleUnmatchedRoute);
  app.use(
    createErrorHandler({
      logger,
      getCorrelationId,
      isDebugInfoExposed: dependencies.isDebugInfoExposed,
    }),
  );
  return app;
}
