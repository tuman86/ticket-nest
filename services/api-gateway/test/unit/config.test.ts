import { ConfigError, loadConfig } from '@ticketnest/config';
import { describe, expect, it } from 'vitest';

import { gatewayConfigSchema } from '@/config';

const VALID_ENVIRONMENT = {
  PORT: '4000',
  REDIS_URL: 'redis://:s3cret-redis@localhost:6379',
  JWT_ISSUER: 'https://auth.ticketnest.example',
  JWT_AUDIENCE: 'ticketnest-api',
  AUTH_SERVICE_URL: 'http://localhost:4001',
  CATALOG_SERVICE_URL: 'http://localhost:4002',
};

describe('gatewayConfigSchema', () => {
  it('applies defaults', () => {
    expect(loadConfig(gatewayConfigSchema, VALID_ENVIRONMENT)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      MAX_REQUEST_BODY_BYTES: 1_048_576,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      TRUST_PROXY_HOPS: 0,
    });
  });

  it.each(['REDIS_URL', 'JWT_ISSUER', 'JWT_AUDIENCE', 'AUTH_SERVICE_URL', 'CATALOG_SERVICE_URL'])(
    'requires %s',
    (name) => {
      const environment = Object.fromEntries(
        Object.entries(VALID_ENVIRONMENT).filter(([key]) => key !== name),
      );

      expect(() => loadConfig(gatewayConfigSchema, environment)).toThrow(`${name}: required`);
    },
  );

  it.each([
    ['a path', 'http://localhost:4001/v1'],
    ['a trailing slash', 'http://localhost:4001/'],
    ['another scheme', 'ftp://localhost:4001'],
    ['no scheme', 'localhost:4001'],
  ])('rejects a service URL with %s', (_name, value) => {
    expect(() =>
      loadConfig(gatewayConfigSchema, { ...VALID_ENVIRONMENT, AUTH_SERVICE_URL: value }),
    ).toThrow(/AUTH_SERVICE_URL/);
  });

  it('reads TRUST_PROXY_HOPS as a whole number and rejects nonsense', () => {
    expect(
      loadConfig(gatewayConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: '1' })
        .TRUST_PROXY_HOPS,
    ).toBe(1);
    expect(() =>
      loadConfig(gatewayConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: '11' }),
    ).toThrow(ConfigError);
  });

  it('splits and trims CORS_ORIGINS', () => {
    const config = loadConfig(gatewayConfigSchema, {
      ...VALID_ENVIRONMENT,
      CORS_ORIGINS: 'https://a.example, https://b.example:8443',
    });

    expect(config.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it.each(['500', '999999999'])('rejects MAX_REQUEST_BODY_BYTES=%s', (value) => {
    expect(() =>
      loadConfig(gatewayConfigSchema, { ...VALID_ENVIRONMENT, MAX_REQUEST_BODY_BYTES: value }),
    ).toThrow(/MAX_REQUEST_BODY_BYTES/);
  });

  it('lists every bad variable without echoing secret values', () => {
    const attempt = () =>
      loadConfig(gatewayConfigSchema, {
        PORT: '4000',
        REDIS_URL: 'mysql://user:s3cret-pw@localhost/db',
        SHUTDOWN_TIMEOUT_MS: '5',
      });

    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const { message } = error as ConfigError;
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('AUTH_SERVICE_URL: required but missing');
      expect(message).toContain('SHUTDOWN_TIMEOUT_MS');
      expect(message).not.toContain('s3cret-pw');
    }
  });
});

describe('gatewayConfigSchema upstream URLs in production', () => {
  const PRODUCTION = { ...VALID_ENVIRONMENT, NODE_ENV: 'production' };

  it('refuses plain http service URLs and names the variables, not their values', () => {
    expect(() => loadConfig(gatewayConfigSchema, PRODUCTION)).toThrow(
      /AUTH_SERVICE_URL: must start with https:\/\/ in production/,
    );
    expect(() => loadConfig(gatewayConfigSchema, PRODUCTION)).toThrow(/CATALOG_SERVICE_URL: must/);
  });

  it('accepts https service URLs', () => {
    expect(
      loadConfig(gatewayConfigSchema, {
        ...PRODUCTION,
        AUTH_SERVICE_URL: 'https://auth.internal.example',
        CATALOG_SERVICE_URL: 'https://catalog.internal.example',
      }).AUTH_SERVICE_URL,
    ).toBe('https://auth.internal.example');
  });

  it('accepts http when ALLOW_INSECURE_UPSTREAMS says the network is private', () => {
    expect(
      loadConfig(gatewayConfigSchema, { ...PRODUCTION, ALLOW_INSECURE_UPSTREAMS: 'true' })
        .ALLOW_INSECURE_UPSTREAMS,
    ).toBe(true);
  });

  it('does not require https outside production', () => {
    expect(() => loadConfig(gatewayConfigSchema, VALID_ENVIRONMENT)).not.toThrow();
  });
});
