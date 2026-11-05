import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigError } from '@/config-error';
import { loadConfig } from '@/load-config';
import { outboxRelayConfigShape, requireBrokerUrlWhenRelayEnabled } from '@/outbox-relay-config';

const BROKER_URL = 'amqp://ticketnest:s3cret-broker-pw@localhost:5672/ticketnest';

const relaySchema = z.object(outboxRelayConfigShape);
const checkedRelaySchema = relaySchema.superRefine(requireBrokerUrlWhenRelayEnabled);

/**
 * @param environment - Environment variables as text, the way `process.env` holds them.
 * @returns The parse result of the bare shape, without the cross-field check.
 */
function parseShape(environment: Record<string, string>) {
  return relaySchema.safeParse(environment);
}

/**
 * @param environment - Environment variables as text.
 * @returns The `ConfigError` that loading the checked schema throws.
 * @throws Error when loading succeeds, because the test expected a failure.
 */
function captureConfigError(environment: Record<string, string>): ConfigError {
  try {
    loadConfig(checkedRelaySchema, environment);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('outboxRelayConfigShape', () => {
  it('applies the defaults: enabled, poll 1000, batch 50', () => {
    expect(parseShape({}).data).toMatchObject({
      OUTBOX_RELAY_ENABLED: true,
      OUTBOX_RELAY_POLL_INTERVAL_MS: 1000,
      OUTBOX_RELAY_BATCH_SIZE: 50,
    });
  });

  it('leaves RABBITMQ_URL undefined when unset', () => {
    expect(parseShape({}).data?.RABBITMQ_URL).toBeUndefined();
  });

  it.each([BROKER_URL, 'amqps://user:pw@broker.example:5671/prod', 'amqp://localhost'])(
    'accepts the broker URL %s',
    (url) => {
      expect(parseShape({ RABBITMQ_URL: url }).data?.RABBITMQ_URL).toBe(url);
    },
  );

  it.each(['http://localhost:5672', 'redis://localhost:6379', 'postgres://localhost:5432/auth'])(
    'rejects the URL scheme of %s',
    (url) => {
      expect(parseShape({ RABBITMQ_URL: url }).success).toBe(false);
    },
  );

  it('rejects an unparsable RABBITMQ_URL', () => {
    expect(parseShape({ RABBITMQ_URL: 'not a url' }).success).toBe(false);
  });

  it.each(['false', '0', 'no'])('reads OUTBOX_RELAY_ENABLED=%s as off', (value) => {
    expect(parseShape({ OUTBOX_RELAY_ENABLED: value }).data?.OUTBOX_RELAY_ENABLED).toBe(false);
  });

  it.each(['true', '1', 'yes'])('reads OUTBOX_RELAY_ENABLED=%s as on', (value) => {
    expect(parseShape({ OUTBOX_RELAY_ENABLED: value }).data?.OUTBOX_RELAY_ENABLED).toBe(true);
  });

  it('rejects OUTBOX_RELAY_ENABLED=maybe', () => {
    expect(parseShape({ OUTBOX_RELAY_ENABLED: 'maybe' }).success).toBe(false);
  });

  it.each(['100', '60000'])('accepts a poll interval of %s', (value) => {
    expect(
      parseShape({ OUTBOX_RELAY_POLL_INTERVAL_MS: value }).data?.OUTBOX_RELAY_POLL_INTERVAL_MS,
    ).toBe(Number(value));
  });

  it.each(['99', '60001', '1.5', 'fast'])('rejects a poll interval of %s', (value) => {
    expect(parseShape({ OUTBOX_RELAY_POLL_INTERVAL_MS: value }).success).toBe(false);
  });

  it.each(['1', '500'])('accepts a batch size of %s', (value) => {
    expect(parseShape({ OUTBOX_RELAY_BATCH_SIZE: value }).data?.OUTBOX_RELAY_BATCH_SIZE).toBe(
      Number(value),
    );
  });

  it.each(['0', '501', '1.5', 'many'])('rejects a batch size of %s', (value) => {
    expect(parseShape({ OUTBOX_RELAY_BATCH_SIZE: value }).success).toBe(false);
  });
});

describe('requireBrokerUrlWhenRelayEnabled', () => {
  it('adds an issue on RABBITMQ_URL when the relay is enabled and the URL is missing', () => {
    const result = checkedRelaySchema.safeParse({ OUTBOX_RELAY_ENABLED: 'true' });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['RABBITMQ_URL']]);
  });

  it('adds no issue when the relay is enabled and the URL is set', () => {
    expect(
      checkedRelaySchema.safeParse({ OUTBOX_RELAY_ENABLED: 'true', RABBITMQ_URL: BROKER_URL })
        .success,
    ).toBe(true);
  });

  it('adds no issue when the relay is disabled and the URL is missing', () => {
    expect(checkedRelaySchema.safeParse({ OUTBOX_RELAY_ENABLED: 'false' }).success).toBe(true);
  });

  it('treats an empty RABBITMQ_URL as missing through loadConfig', () => {
    expect(() => loadConfig(checkedRelaySchema, { RABBITMQ_URL: '' })).toThrow(
      /RABBITMQ_URL: required but missing/,
    );
  });

  it('never puts the URL, password included, in a ConfigError for a bad RABBITMQ_URL', () => {
    const error = captureConfigError({
      RABBITMQ_URL: 'http://ticketnest:s3cret-broker-pw@localhost:5672/ticketnest',
    });

    expect(error.problems.join('\n')).toContain('RABBITMQ_URL');
    expect(JSON.stringify([error.message, error.problems, error.detail])).not.toContain(
      's3cret-broker-pw',
    );
  });
});
