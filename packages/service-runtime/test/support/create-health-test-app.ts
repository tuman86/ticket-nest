import { createLogger } from '@ticketnest/logger';
import express, { type Express } from 'express';

import { createHealthRouter, type HealthRouterDependencies } from '@/express/health.router';

export type LogLine = Record<string, unknown>;

export interface HealthTestApp {
  readonly app: Express;
  readonly lines: LogLine[];
}

/**
 * Mounts the real health router on a bare Express app with a logger that collects its lines.
 *
 * @param overrides - Router dependencies to replace.
 * @returns The app and the collected log lines.
 */
export function createHealthTestApp(
  overrides: Partial<Omit<HealthRouterDependencies, 'logger'>> = {},
): HealthTestApp {
  const lines: LogLine[] = [];
  const logger = createLogger({
    serviceName: 'service-runtime-test',
    level: 'debug',
    nodeEnvironment: 'test',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  const app = express();
  app.use(
    createHealthRouter({
      logger,
      readinessChecks: [],
      isShuttingDown: () => false,
      ...overrides,
    }),
  );
  return { app, lines };
}
