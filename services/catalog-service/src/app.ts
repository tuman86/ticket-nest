import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { getCorrelationId, type Logger } from '@ticketnest/logger';
import { type DependencyCheck } from '@ticketnest/service-runtime';
import {
  createHealthRouter,
  createRequestLogger,
  handleRequestId,
} from '@ticketnest/service-runtime/express';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';

export interface AppDependencies {
  readonly logger: Logger;
  readonly readinessChecks: readonly DependencyCheck[];
  readonly isShuttingDown: () => boolean;
  readonly jsonBodyLimit: string;
  /** Adds the message and stack to 500 responses. Development only. */
  readonly isDebugInfoExposed: boolean;
  /** Feature routers, mounted after the health endpoints. */
  readonly routers?: readonly Router[];
  /**
   * How many reverse proxies in front of the service to trust for the client IP
   * (`X-Forwarded-For`). Leave unset or 0 when clients reach the service directly, so no client
   * can choose its own IP; set 1 behind the gateway.
   */
  readonly trustProxyHops?: number;
  readonly checkTimeoutMs?: number;
}

/**
 * Builds the Express app. It opens no sockets and creates no clients, so tests can import it.
 * It sets no CORS headers: only the gateway talks to browsers.
 *
 * @param dependencies - The logger, health checks, body limit, feature routers and the number of
 *   proxy hops to trust for the client IP.
 * @returns The configured app, ready to listen or to hand to Supertest.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { logger, jsonBodyLimit, routers = [] } = dependencies;
  const app = express();
  if (dependencies.trustProxyHops !== undefined) {
    app.set('trust proxy', dependencies.trustProxyHops);
  }

  app.use(handleRequestId);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(express.json({ limit: jsonBodyLimit }));

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
