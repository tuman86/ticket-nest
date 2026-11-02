import { ConfigError, loadConfig } from '@ticketnest/config';
import { describe, expect, it } from 'vitest';

import { authConfigSchema } from './config';

const VALID_ENVIRONMENT = {
  PORT: '4001',
  DATABASE_URL: 'postgres://auth_service:s3cret-pw@localhost:5432/auth',
  REDIS_URL: 'redis://:s3cret-redis@localhost:6379',
};

describe('authConfigSchema', () => {
  it('applies defaults', () => {
    expect(loadConfig(authConfigSchema, VALID_ENVIRONMENT)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      JSON_BODY_LIMIT: '100kb',
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it('splits and trims CORS_ORIGINS', () => {
    const config = loadConfig(authConfigSchema, {
      ...VALID_ENVIRONMENT,
      CORS_ORIGINS: 'https://a.example, https://b.example:8443',
    });

    expect(config.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it.each(['https://a.example/', 'a.example', 'https://a.example/path'])(
    'rejects %j as a CORS origin',
    (origin) => {
      expect(() =>
        loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, CORS_ORIGINS: origin }),
      ).toThrow(ConfigError);
    },
  );

  it('lists every bad variable without echoing secret values', () => {
    const attempt = () =>
      loadConfig(authConfigSchema, {
        PORT: '4001',
        DATABASE_URL: 'mysql://user:s3cret-pw@localhost/auth',
        SHUTDOWN_TIMEOUT_MS: '5',
      });

    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const { message } = error as ConfigError;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL: required but missing');
      expect(message).toContain('SHUTDOWN_TIMEOUT_MS');
      expect(message).not.toContain('s3cret-pw');
    }
  });
});
