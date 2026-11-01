import { pino, type DestinationStream, type Logger } from 'pino';

import { buildLoggerOptions, type LoggerSettings } from './build-logger-options';

export type { Logger };

export interface CreateLoggerOptions extends LoggerSettings {
  /** Defaults to stdout. Tests pass a collecting stream. */
  readonly destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const { destination, ...settings } = options;
  const loggerOptions = buildLoggerOptions(settings);
  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}
