import { ConfigError } from '@ticketnest/config';
import { createLogger } from '@ticketnest/logger';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { composeOutboxRelay, type OutboxRelayConfig } from '@/compose-outbox-relay';
import { createPrismaClient } from '@/repositories/create-prisma-client';

const BROKER_PASSWORD = 's3cret-broker-pw';
const BROKER_URL = `amqp://ticketnest:${BROKER_PASSWORD}@127.0.0.1:1/ticketnest`;

const ENABLED_CONFIG: OutboxRelayConfig = {
  OUTBOX_RELAY_ENABLED: true,
  RABBITMQ_URL: BROKER_URL,
  OUTBOX_RELAY_POLL_INTERVAL_MS: 1_000,
  OUTBOX_RELAY_BATCH_SIZE: 50,
};

/** A pool that never gets a query in these tests, so it never opens a connection. */
const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
const prisma = createPrismaClient(pool);

/** Everything the relay logged, as parsed JSON lines. */
const lines: Record<string, unknown>[] = [];
const logger = createLogger({
  serviceName: 'auth-service',
  level: 'debug',
  nodeEnvironment: 'test',
  destination: {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  },
});

afterEach(() => {
  lines.length = 0;
});

describe('composeOutboxRelay', () => {
  it('builds nothing and logs once that the relay is disabled', () => {
    const handle = composeOutboxRelay({
      config: { ...ENABLED_CONFIG, OUTBOX_RELAY_ENABLED: false },
      prisma,
      logger,
    });

    expect(handle.resources).toEqual([]);
    expect(lines.filter((line) => line.msg === 'outbox relay disabled')).toHaveLength(1);
  });

  it('starts nothing when the relay is disabled', () => {
    const handle = composeOutboxRelay({
      config: { ...ENABLED_CONFIG, OUTBOX_RELAY_ENABLED: false, RABBITMQ_URL: undefined },
      prisma,
      logger,
    });

    expect(() => {
      handle.start();
    }).not.toThrow();
    expect(pool.totalCount).toBe(0);
  });

  it('returns the shutdown resources in the order relay, then amqp', () => {
    const handle = composeOutboxRelay({ config: ENABLED_CONFIG, prisma, logger });

    expect(handle.resources.map((resource) => resource.name)).toEqual(['outbox-relay', 'amqp']);
  });

  it('logs that the relay is enabled without the broker URL or its password', () => {
    composeOutboxRelay({ config: ENABLED_CONFIG, prisma, logger });

    expect(lines.some((line) => line.msg === 'outbox relay enabled')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(BROKER_PASSWORD);
    expect(JSON.stringify(lines)).not.toContain('127.0.0.1');
  });

  it('closing the relay resource before start() resolves and makes no store call', async () => {
    const handle = composeOutboxRelay({ config: ENABLED_CONFIG, prisma, logger });
    const [relayResource] = handle.resources;

    await relayResource?.close();

    expect(relayResource?.name).toBe('outbox-relay');
    expect(pool.totalCount).toBe(0);
  });

  it('closing the amqp resource when it never connected resolves without throwing', async () => {
    const handle = composeOutboxRelay({ config: ENABLED_CONFIG, prisma, logger });
    const amqpResource = handle.resources.find((resource) => resource.name === 'amqp');

    await expect(amqpResource?.close()).resolves.toBeUndefined();
  });

  it('refuses to build an enabled relay without a broker URL', () => {
    expect(() =>
      composeOutboxRelay({
        config: { ...ENABLED_CONFIG, RABBITMQ_URL: undefined },
        prisma,
        logger,
      }),
    ).toThrow(ConfigError);
  });
});
