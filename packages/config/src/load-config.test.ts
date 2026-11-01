import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { baseConfigSchema } from './base-config-schema';
import { ConfigError } from './config-error';
import { loadConfig } from './load-config';

const serviceConfigSchema = baseConfigSchema.extend({
  DATABASE_URL: z.url(),
  HOLD_TTL_MS: z.coerce.number().int().positive().default(600_000),
});

const validSource = { PORT: '3001', DATABASE_URL: 'postgres://user:pass@localhost:5432/booking' };

function captureConfigError(source: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(serviceConfigSchema, source);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('returns a typed config merging base and service fields', () => {
    const config = loadConfig(serviceConfigSchema, validSource);
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      LOG_LEVEL: 'info',
      DATABASE_URL: validSource.DATABASE_URL,
      HOLD_TTL_MS: 600_000,
    });
  });

  it('throws ConfigError naming missing variables', () => {
    const error = captureConfigError({});
    expect(error.message).toContain('Invalid environment configuration:');
    expect(error.problems).toContain('PORT: required but missing');
    expect(error.problems).toContain('DATABASE_URL: required but missing');
  });

  it('reports every problem in one error', () => {
    const error = captureConfigError({ PORT: 'abc', DATABASE_URL: 'not-a-url', LOG_LEVEL: 'loud' });
    expect(error.problems).toHaveLength(3);
    expect(error.problems.map((problem) => problem.split(':')[0])).toEqual(
      expect.arrayContaining(['PORT', 'DATABASE_URL', 'LOG_LEVEL']),
    );
  });

  it('treats an empty string as missing', () => {
    const error = captureConfigError({ PORT: '', DATABASE_URL: validSource.DATABASE_URL });
    expect(error.problems).toEqual(['PORT: required but missing']);
  });

  it('lets an empty string fall back to the default', () => {
    const config = loadConfig(serviceConfigSchema, { ...validSource, LOG_LEVEL: '' });
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('never includes invalid values in the message', () => {
    const secret = 's3cr3t-value-that-must-not-leak';
    const error = captureConfigError({ PORT: secret, DATABASE_URL: secret, LOG_LEVEL: secret });
    expect(error.message).not.toContain(secret);
    expect(error.problems.join('\n')).not.toContain(secret);
  });

  it('does not mutate the source', () => {
    const source = { ...validSource, EMPTY: '' };
    const snapshot = { ...source };
    loadConfig(serviceConfigSchema, source);
    expect(source).toEqual(snapshot);
  });

  it('reads process.env when no source is given', () => {
    vi.stubEnv('PORT', '4000');
    vi.stubEnv('DATABASE_URL', validSource.DATABASE_URL);
    expect(loadConfig(serviceConfigSchema).PORT).toBe(4000);
  });
});
