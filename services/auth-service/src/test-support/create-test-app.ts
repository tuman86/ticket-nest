import { createLogger, type Logger } from '@ticketnest/logger';
import { type Express } from 'express';

import { createApp, type AppDependencies } from '../app';

export type LogLine = Record<string, unknown>;

export interface TestApp {
  readonly app: Express;
  readonly logger: Logger;
  readonly lines: LogLine[];
}

/** Builds the real app with fake dependencies and a logger that collects its lines. */
export function createTestApp(overrides: Partial<AppDependencies> = {}): TestApp {
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
    ...overrides,
  });
  return { app, logger, lines };
}
