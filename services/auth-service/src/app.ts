import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { getCorrelationId, type Logger } from '@ticketnest/logger';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';

import { type DependencyCheck } from './health/dependency-check';
import { createHealthRouter } from './health/health.router';
import { handleRequestId } from './http/request-id.middleware';
import { createRequestLogger } from './http/request-logger.middleware';

export interface AppDependencies {
  readonly logger: Logger;
  readonly readinessChecks: readonly DependencyCheck[];
  readonly isShuttingDown: () => boolean;
  readonly corsOrigins: readonly string[];
  readonly jsonBodyLimit: string;
  /** Adds the message and stack to 500 responses. Development only. */
  readonly isDebugInfoExposed: boolean;
  /** Feature routers, mounted after the health endpoints. */
  readonly routers?: readonly Router[];
  readonly checkTimeoutMs?: number;
}

/** Builds the Express app. It opens no sockets and creates no clients, so tests can import it. */
export function createApp(dependencies: AppDependencies): Express {
  const { logger, corsOrigins, jsonBodyLimit, routers = [] } = dependencies;
  const app = express();

  app.use(handleRequestId);
  app.use(createRequestLogger(logger));
  app.use(helmet());
  app.use(cors({ origin: [...corsOrigins] }));
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
