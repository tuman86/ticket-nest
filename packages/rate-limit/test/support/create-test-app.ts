import { createErrorHandler, handleUnmatchedRoute } from '@ticketnest/errors/express';
import { type Logger } from '@ticketnest/logger';
import express, { type Express, type Router } from 'express';

import { createTestLogger, type LogLine } from './create-test-logger';

export interface TestApp {
  readonly app: Express;
  readonly logger: Logger;
  readonly lines: LogLine[];
}

/**
 * Builds a small Express app with the shared error handler, so a middleware under test answers
 * the same problem+json a real service would.
 *
 * @param buildRouters - Builds the routers to mount. It gets the test logger.
 * @returns The app, the logger and the collected log lines.
 */
export function createTestApp(buildRouters: (logger: Logger) => readonly Router[]): TestApp {
  const { logger, lines } = createTestLogger();
  const app = express();
  app.use(express.json());
  for (const router of buildRouters(logger)) {
    app.use(router);
  }
  app.use(handleUnmatchedRoute);
  app.use(
    createErrorHandler({ logger, getCorrelationId: () => undefined, isDebugInfoExposed: false }),
  );
  return { app, logger, lines };
}
