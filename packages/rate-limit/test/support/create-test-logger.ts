import { createLogger, type Logger } from '@ticketnest/logger';

export type LogLine = Record<string, unknown>;

export interface TestLogger {
  readonly logger: Logger;
  /** Every line the logger wrote, parsed. */
  readonly lines: LogLine[];
}

/**
 * Builds a logger that collects its lines instead of printing them.
 *
 * @returns The logger and the lines it has written so far.
 */
export function createTestLogger(): TestLogger {
  const lines: LogLine[] = [];
  const logger = createLogger({
    serviceName: 'rate-limit-test',
    level: 'debug',
    nodeEnvironment: 'test',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  });
  return { logger, lines };
}
