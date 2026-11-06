import { ConfigError, loadConfig } from '@ticketnest/config';
import { describe, expect, it } from 'vitest';

import { catalogConfigSchema } from '@/config';

const VALID_ENVIRONMENT = {
  PORT: '4002',
  DATABASE_URL: 'postgres://catalog_service:s3cret-pw@localhost:5432/catalog',
};

describe('catalogConfigSchema', () => {
  it('applies defaults', () => {
    expect(loadConfig(catalogConfigSchema, VALID_ENVIRONMENT)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      JSON_BODY_LIMIT: '100kb',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      TRUST_PROXY_HOPS: 0,
    });
  });

  it('needs no Redis, broker or signing-key variable', () => {
    expect(() => loadConfig(catalogConfigSchema, VALID_ENVIRONMENT)).not.toThrow();
  });

  describe('DATABASE_URL', () => {
    it.each([
      'postgres://catalog_service:pw@localhost:5432/catalog',
      'postgresql://catalog_service:pw@localhost:5432/catalog',
    ])('accepts %s', (url) => {
      expect(
        loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, DATABASE_URL: url }).DATABASE_URL,
      ).toBe(url);
    });

    it('is required', () => {
      expect(() => loadConfig(catalogConfigSchema, { PORT: '4002' })).toThrow(
        'DATABASE_URL: required',
      );
    });

    it.each(['mysql://user:pw@localhost/catalog', 'redis://:pw@localhost:6379', 'not a url'])(
      'rejects %j',
      (url) => {
        expect(() =>
          loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, DATABASE_URL: url }),
        ).toThrow(ConfigError);
      },
    );
  });

  describe('TRUST_PROXY_HOPS', () => {
    it('reads a whole number', () => {
      expect(
        loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: '1' })
          .TRUST_PROXY_HOPS,
      ).toBe(1);
    });

    it.each(['-1', '1.5', 'many', '11'])('rejects %s', (value) => {
      expect(() =>
        loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: value }),
      ).toThrow(ConfigError);
    });
  });

  it('reads JSON_BODY_LIMIT through the shared schema', () => {
    expect(
      loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, JSON_BODY_LIMIT: '500kb' })
        .JSON_BODY_LIMIT,
    ).toBe('500kb');
    expect(() =>
      loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, JSON_BODY_LIMIT: '5gb' }),
    ).toThrow(ConfigError);
  });

  it('rejects a SHUTDOWN_TIMEOUT_MS under one second', () => {
    expect(() =>
      loadConfig(catalogConfigSchema, { ...VALID_ENVIRONMENT, SHUTDOWN_TIMEOUT_MS: '999' }),
    ).toThrow(/SHUTDOWN_TIMEOUT_MS/);
  });

  it('lists every bad variable without echoing secret values', () => {
    /** Loads an environment with a wrong scheme, a short timeout and no port. */
    const attempt = () =>
      loadConfig(catalogConfigSchema, {
        DATABASE_URL: 'mysql://user:s3cret-pw@localhost/catalog',
        SHUTDOWN_TIMEOUT_MS: '5',
      });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/DATABASE_URL/);
    expect(attempt).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    expect(attempt).toThrow(/PORT/);
    expect(attempt).not.toThrow(/s3cret-pw/);
  });
});
