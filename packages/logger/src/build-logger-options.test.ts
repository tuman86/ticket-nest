import { describe, expect, it } from 'vitest';

import { buildLoggerOptions } from './build-logger-options';

const baseSettings = { serviceName: 'auth-service', level: 'info' } as const;

describe('buildLoggerOptions', () => {
  it('configures the pino-pretty transport only in development', () => {
    const development = buildLoggerOptions({ ...baseSettings, nodeEnvironment: 'development' });

    expect(development.transport).toEqual({ target: 'pino-pretty' });
  });

  it.each(['test', 'production'] as const)('has no transport in %s', (nodeEnvironment) => {
    const options = buildLoggerOptions({ ...baseSettings, nodeEnvironment });

    expect(options.transport).toBeUndefined();
    expect(options.formatters).toBeDefined();
  });

  it('passes the level and service name through', () => {
    const options = buildLoggerOptions({
      serviceName: 'auth-service',
      level: 'debug',
      nodeEnvironment: 'production',
    });

    expect(options.level).toBe('debug');
    expect(options.base).toEqual({ service: 'auth-service' });
  });
});
