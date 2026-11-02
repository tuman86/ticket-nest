import { createLogger, type Logger } from '@ticketnest/logger';
import { type Express, type Router } from 'express';

import { createApp, type AppDependencies } from '../app';

export type LogLine = Record<string, unknown>;

export interface TestApp {
  readonly app: Express;
  readonly logger: Logger;
  readonly lines: LogLine[];
}

export interface CreateTestAppOptions {
  /** Builds feature routers that need the test logger (for example to log from a service). */
  readonly buildRouters?: (logger: Logger) => readonly Router[];
}

/**
 * Builds the real app with fake dependencies and a logger that collects its lines.
 *
 * @param overrides - App dependencies to replace.
 * @param options - Extra test wiring.
 * @returns The app, the logger and the collected log lines.
 */
export function createTestApp(
  overrides: Partial<AppDependencies> = {},
  options: CreateTestAppOptions = {},
): TestApp {
  const lines: LogLine[] = [];
  const logger = createLogger({
    serviceName: 'auth-service',
    level: 'debug',
    nodeEnvironment: 'test',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  const app = createApp({
    logger,
    readinessChecks: [],
    isShuttingDown: () => false,
    corsOrigins: [],
    jsonBodyLimit: '1kb',
    isDebugInfoExposed: false,
    ...(options.buildRouters === undefined ? {} : { routers: options.buildRouters(logger) }),
    ...overrides,
  });
  return { app, logger, lines };
}
