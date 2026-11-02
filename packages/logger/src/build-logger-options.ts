import { type BaseConfig } from '@ticketnest/config';
import { type LoggerOptions, stdTimeFunctions } from 'pino';

import { getCorrelationId } from './correlation-context';
import { REDACTED_PATHS, REDACTION_CENSOR } from './redaction-paths';

export interface LoggerSettings {
  readonly serviceName: string;
  readonly level: BaseConfig['LOG_LEVEL'];
  readonly nodeEnvironment: BaseConfig['NODE_ENV'];
}

function addCorrelationId(): { correlationId?: string } {
  const correlationId = getCorrelationId();
  return correlationId === undefined ? {} : { correlationId };
}

/**
 * Pure so tests can inspect the rules. Pretty output is a development-only transport:
 * in `test` and `production` pino-pretty is never configured, so it is never loaded.
 */
export function buildLoggerOptions(settings: LoggerSettings): LoggerOptions {
  const isPrettyOutputEnabled = settings.nodeEnvironment === 'development';

  return {
    level: settings.level,
    base: { service: settings.serviceName },
    timestamp: stdTimeFunctions.isoTime,
    mixin: addCorrelationId,
    redact: { paths: [...REDACTED_PATHS], censor: REDACTION_CENSOR },
    // pino-pretty reads numeric levels, so string labels are for the JSON output only.
    ...(isPrettyOutputEnabled
      ? { transport: { target: 'pino-pretty' } }
      : { formatters: { level: (label: string) => ({ level: label }) } }),
  };
}
