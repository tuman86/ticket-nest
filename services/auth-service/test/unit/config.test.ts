import { ConfigError, loadConfig } from '@ticketnest/config';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

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

/**
 * @param publicKey - A public key.
 * @returns It as base64 of its SPKI PEM, the form `JWT_ADDITIONAL_PUBLIC_KEYS` entries take.
 */
function encodePublicKey(publicKey: KeyObject): string {
  return Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
}

/** @returns A fresh Ed25519 public key, encoded for the environment. */
function generateEncodedPublicKey(): string {
  return encodePublicKey(generateKeyPairSync('ed25519').publicKey);
}

const ENCODED_PRIVATE_KEY = generateEncodedPrivateKey('ed25519');

const VALID_ENVIRONMENT = {
  PORT: '4001',
  DATABASE_URL: 'postgres://auth_service:s3cret-pw@localhost:5432/auth',
  REDIS_URL: 'redis://:s3cret-redis@localhost:6379',
  JWT_PRIVATE_KEY: ENCODED_PRIVATE_KEY,
  JWT_ISSUER: 'https://auth.ticketnest.example',
  JWT_AUDIENCE: 'ticketnest-api',
  RATE_LIMIT_KEY_PEPPER: 'test-only-pepper-0123456789abcdef-xyz',
  RABBITMQ_URL: 'amqp://ticketnest:s3cret-broker-pw@localhost:5672/ticketnest',
};

describe('authConfigSchema', () => {
  it('applies defaults', () => {
    expect(loadConfig(authConfigSchema, VALID_ENVIRONMENT)).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      JSON_BODY_LIMIT: '100kb',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      TRUST_PROXY_HOPS: 0,
    });
  });

  describe('rate limiting', () => {
    it('reads TRUST_PROXY_HOPS as a whole number', () => {
      expect(
        loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: '1' })
          .TRUST_PROXY_HOPS,
      ).toBe(1);
    });

    it.each(['-1', '1.5', 'many', '11'])('rejects TRUST_PROXY_HOPS=%s', (value) => {
      expect(() =>
        loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, TRUST_PROXY_HOPS: value }),
      ).toThrow(ConfigError);
    });

    it('requires RATE_LIMIT_KEY_PEPPER', () => {
      const withoutPepper = Object.fromEntries(
        Object.entries(VALID_ENVIRONMENT).filter(([name]) => name !== 'RATE_LIMIT_KEY_PEPPER'),
      );

      expect(() => loadConfig(authConfigSchema, withoutPepper)).toThrow(/RATE_LIMIT_KEY_PEPPER/);
    });

    it('rejects a pepper that is too short, without echoing it', () => {
      /** Loads the environment with a pepper that is too short. */
      const attempt = () =>
        loadConfig(authConfigSchema, {
          ...VALID_ENVIRONMENT,
          RATE_LIMIT_KEY_PEPPER: 'short-pepper',
        });

      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(/RATE_LIMIT_KEY_PEPPER/);
      expect(attempt).not.toThrow(/short-pepper/);
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
      expect(config.JWT_ISSUER).toBe('https://auth.ticketnest.example');
      expect(config.JWT_AUDIENCE).toBe('ticketnest-api');
    });

    it.each(['JWT_PRIVATE_KEY', 'JWT_ISSUER', 'JWT_AUDIENCE'])('requires %s', (name) => {
      const environment = Object.fromEntries(
        Object.entries(VALID_ENVIRONMENT).filter(([key]) => key !== name),
      );

      expect(() => loadConfig(authConfigSchema, environment)).toThrow(`${name}: required`);
    });

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

describe('JWT_ADDITIONAL_PUBLIC_KEYS', () => {
  it('defaults to no additional keys', () => {
    expect(loadConfig(authConfigSchema, VALID_ENVIRONMENT).JWT_ADDITIONAL_PUBLIC_KEYS).toEqual([]);
  });

  it('parses a comma-separated list into Ed25519 public key objects', () => {
    const first = generateKeyPairSync('ed25519').publicKey;
    const second = generateKeyPairSync('ed25519').publicKey;

    const config = loadConfig(authConfigSchema, {
      ...VALID_ENVIRONMENT,
      JWT_ADDITIONAL_PUBLIC_KEYS: ` ${encodePublicKey(first)} , ${encodePublicKey(second)} `,
    });

    expect(config.JWT_ADDITIONAL_PUBLIC_KEYS).toHaveLength(2);
    for (const key of config.JWT_ADDITIONAL_PUBLIC_KEYS) {
      expect(key.type).toBe('public');
      expect(key.asymmetricKeyType).toBe('ed25519');
    }
    expect(config.JWT_ADDITIONAL_PUBLIC_KEYS[0]?.export({ format: 'jwk' })).toEqual(
      first.export({ format: 'jwk' }),
    );
  });

  it('accepts exactly three additional keys', () => {
    const value = [1, 2, 3].map(generateEncodedPublicKey).join(',');

    const config = loadConfig(authConfigSchema, {
      ...VALID_ENVIRONMENT,
      JWT_ADDITIONAL_PUBLIC_KEYS: value,
    });

    expect(config.JWT_ADDITIONAL_PUBLIC_KEYS).toHaveLength(3);
  });

  const signingPublicKey = encodePublicKey(
    createPublicKey(Buffer.from(ENCODED_PRIVATE_KEY, 'base64').toString('utf8')),
  );
  const duplicated = generateEncodedPublicKey();

  it.each([
    ['text that is not a key', Buffer.from('not a key').toString('base64')],
    ['a value that is not base64 PEM', 'definitely not base64 !!!'],
    ['a private key, which must never sit in a verify-only list', ENCODED_PRIVATE_KEY],
    [
      'an RSA public key',
      encodePublicKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey),
    ],
    ['an Ed448 public key', encodePublicKey(generateKeyPairSync('ed448').publicKey)],
    ['the signing key itself', signingPublicKey],
    ['the same key twice', `${duplicated},${duplicated}`],
    ['more than three keys', [1, 2, 3, 4].map(generateEncodedPublicKey).join(',')],
  ])('rejects %s without echoing it', (_name, value) => {
    try {
      loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, JWT_ADDITIONAL_PUBLIC_KEYS: value });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { message } = error as ConfigError;
      expect(message).toContain('JWT_ADDITIONAL_PUBLIC_KEYS');
      for (const entry of value.split(',')) {
        if (entry.trim().length > 8) {
          expect(message).not.toContain(entry.trim());
        }
      }
    }
  });
});

describe('REFRESH_REUSE_GRACE_MS', () => {
  it('defaults to 10 seconds', () => {
    expect(loadConfig(authConfigSchema, VALID_ENVIRONMENT).REFRESH_REUSE_GRACE_MS).toBe(10_000);
  });

  it('accepts a value up to 30 seconds and rejects a larger one', () => {
    expect(
      loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, REFRESH_REUSE_GRACE_MS: '30000' })
        .REFRESH_REUSE_GRACE_MS,
    ).toBe(30_000);
    expect(() =>
      loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, REFRESH_REUSE_GRACE_MS: '30001' }),
    ).toThrow('REFRESH_REUSE_GRACE_MS');
  });
});

describe('outbox relay variables', () => {
  /** @returns The valid environment without `RABBITMQ_URL`, for the cases that leave it out. */
  function environmentWithoutBrokerUrl(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(VALID_ENVIRONMENT).filter(([name]) => name !== 'RABBITMQ_URL'),
    );
  }

  it('defaults the relay to enabled with a poll interval of 1000 and a batch size of 50', () => {
    expect(loadConfig(authConfigSchema, VALID_ENVIRONMENT)).toMatchObject({
      OUTBOX_RELAY_ENABLED: true,
      OUTBOX_RELAY_POLL_INTERVAL_MS: 1_000,
      OUTBOX_RELAY_BATCH_SIZE: 50,
    });
  });

  it('reads the relay variables from the environment', () => {
    expect(
      loadConfig(authConfigSchema, {
        ...VALID_ENVIRONMENT,
        OUTBOX_RELAY_POLL_INTERVAL_MS: '250',
        OUTBOX_RELAY_BATCH_SIZE: '200',
      }),
    ).toMatchObject({
      RABBITMQ_URL: VALID_ENVIRONMENT.RABBITMQ_URL,
      OUTBOX_RELAY_POLL_INTERVAL_MS: 250,
      OUTBOX_RELAY_BATCH_SIZE: 200,
    });
  });

  it('refuses to start without RABBITMQ_URL while the relay is enabled', () => {
    expect(() => loadConfig(authConfigSchema, environmentWithoutBrokerUrl())).toThrow(
      /RABBITMQ_URL: required but missing/,
    );
  });

  it('starts without RABBITMQ_URL when OUTBOX_RELAY_ENABLED=false', () => {
    const config = loadConfig(authConfigSchema, {
      ...environmentWithoutBrokerUrl(),
      OUTBOX_RELAY_ENABLED: 'false',
    });

    expect(config.OUTBOX_RELAY_ENABLED).toBe(false);
    expect(config.RABBITMQ_URL).toBeUndefined();
  });

  it('names RABBITMQ_URL and never prints its password in the ConfigError', () => {
    const badUrl = 'http://ticketnest:s3cret-broker-pw@localhost:5672/ticketnest';
    let message = '';
    try {
      loadConfig(authConfigSchema, { ...VALID_ENVIRONMENT, RABBITMQ_URL: badUrl });
    } catch (error) {
      message = error instanceof ConfigError ? error.message : String(error);
    }

    expect(message).toContain('RABBITMQ_URL');
    expect(message).not.toContain('s3cret-broker-pw');
  });
});
