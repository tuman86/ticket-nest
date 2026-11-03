import { ConfigError, loadConfig } from '@ticketnest/config';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { authConfigSchema } from '@/config';

/**
 * @param type - Key algorithm to generate.
 * @returns A throwaway private key as base64 of its PKCS#8 PEM, the form `JWT_PRIVATE_KEY` takes.
 */
function generateEncodedPrivateKey(type: 'ed25519' | 'rsa'): string {
  const { privateKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return Buffer.from(pem).toString('base64');
}

const ENCODED_PRIVATE_KEY = generateEncodedPrivateKey('ed25519');

const VALID_ENVIRONMENT = {
  PORT: '4001',
  DATABASE_URL: 'postgres://auth_service:s3cret-pw@localhost:5432/auth',
  REDIS_URL: 'redis://:s3cret-redis@localhost:6379',
  JWT_PRIVATE_KEY: ENCODED_PRIVATE_KEY,
  JWT_KEY_ID: 'key-2026-11',
  JWT_ISSUER: 'https://auth.ticketnest.example',
  JWT_AUDIENCE: 'ticketnest-api',
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

  describe('signing key variables', () => {
    it('parses the base64 PEM into an Ed25519 private key', () => {
      const config = loadConfig(authConfigSchema, VALID_ENVIRONMENT);

      expect(config.JWT_PRIVATE_KEY.type).toBe('private');
      expect(config.JWT_PRIVATE_KEY.asymmetricKeyType).toBe('ed25519');
      expect(config.JWT_KEY_ID).toBe('key-2026-11');
      expect(config.JWT_ISSUER).toBe('https://auth.ticketnest.example');
      expect(config.JWT_AUDIENCE).toBe('ticketnest-api');
    });

    it.each(['JWT_PRIVATE_KEY', 'JWT_KEY_ID', 'JWT_ISSUER', 'JWT_AUDIENCE'])(
      'requires %s',
      (name) => {
        const environment = Object.fromEntries(
          Object.entries(VALID_ENVIRONMENT).filter(([key]) => key !== name),
        );

        expect(() => loadConfig(authConfigSchema, environment)).toThrow(`${name}: required`);
      },
    );

    it.each([
      ['text that is not a key', Buffer.from('not a key').toString('base64')],
      ['a key that is not base64 encoded PEM', 'definitely not base64 !!!'],
      ['an RSA key, which this service does not sign with', generateEncodedPrivateKey('rsa')],
    ])('rejects %s without echoing it', (_name, value) => {
      try {
        loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, JWT_PRIVATE_KEY: value });
        expect.unreachable('loadConfig should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const { message } = error as ConfigError;
        expect(message).toContain('JWT_PRIVATE_KEY');
        expect(message).not.toContain(value);
      }
    });
  });
});
