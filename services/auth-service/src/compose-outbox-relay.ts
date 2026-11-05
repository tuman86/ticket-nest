import { ConfigError } from '@ticketnest/config';
import { type Logger } from '@ticketnest/logger';
import { UuidGenerator } from '@ticketnest/messaging';
import {
  AmqpEventPublisher,
  MathRandomSource,
  OutboxRelay,
  sleepUnlessAborted,
} from '@ticketnest/messaging/relay';
import { type ShutdownResource } from '@ticketnest/service-runtime';

import { type AuthConfig } from './config';
import { type DatabaseClient } from './repositories/create-prisma-client';
import { PrismaOutboxRelayRepository } from './repositories/prisma-outbox-relay.repository';

/** The producing domain of this service: its events go to the `auth.events` exchange (ADR-0005). */
const AUTH_EVENT_DOMAIN = 'auth';

/** The relay settings of the validated configuration. */
export type OutboxRelayConfig = Pick<
  AuthConfig,
  | 'OUTBOX_RELAY_ENABLED'
  | 'RABBITMQ_URL'
  | 'OUTBOX_RELAY_POLL_INTERVAL_MS'
  | 'OUTBOX_RELAY_BATCH_SIZE'
>;

export interface ComposeOutboxRelayOptions {
  readonly config: OutboxRelayConfig;
  /** The service's Prisma client. The caller owns it and closes it on shutdown. */
  readonly prisma: DatabaseClient;
  readonly logger: Logger;
}

/** A relay that is built but not running, and what to close when the service shuts down. */
export interface OutboxRelayHandle {
  /** Starts the relay loop in the background. Does nothing when the relay is disabled. */
  start: () => void;
  /**
   * What to close on shutdown, in this order and before the Postgres pool: first the relay (it
   * waits for the batch in flight and then fences its store), then the AMQP connection. Empty when
   * the relay is disabled.
   */
  readonly resources: readonly ShutdownResource[];
}

/**
 * @param config - The relay settings of an enabled relay.
 * @returns The broker URL.
 * @throws ConfigError when there is none. The configuration schema already refuses that, so this
 * guards a caller that skipped the schema. The message names the variable and never a value.
 */
function requireBrokerUrl(config: OutboxRelayConfig): string {
  if (config.RABBITMQ_URL === undefined) {
    throw new ConfigError('Invalid environment configuration:\n  - RABBITMQ_URL: required', [
      'RABBITMQ_URL: required while OUTBOX_RELAY_ENABLED is true',
    ]);
  }
  return config.RABBITMQ_URL;
}

/**
 * Part of the composition root (with `server.ts`): the only place that names the relay's store,
 * the AMQP publisher and the relay itself and connects them (ADR-0007).
 *
 * Nothing connects here. The publisher opens the broker connection on the relay's first tick, so a
 * broker that is down at boot only delays publishing. The relay does not touch `/health/ready`.
 *
 * @param options - The relay settings, the Prisma client and the logger.
 * @returns The relay and its shutdown resources, or a handle that does nothing when disabled.
 * @throws ConfigError when the relay is enabled and there is no broker URL.
 * @throws InvalidBrokerUrlError when the broker URL cannot be parsed. The error never holds the URL.
 */
export function composeOutboxRelay(options: ComposeOutboxRelayOptions): OutboxRelayHandle {
  const { config, prisma, logger } = options;
  if (!config.OUTBOX_RELAY_ENABLED) {
    logger.info('outbox relay disabled');
    return { start: () => undefined, resources: [] };
  }
  const publisher = new AmqpEventPublisher({
    url: requireBrokerUrl(config),
    domain: AUTH_EVENT_DOMAIN,
    logger,
  });
  const relay = new OutboxRelay({
    store: new PrismaOutboxRelayRepository(prisma),
    publisher,
    idGenerator: new UuidGenerator(),
    randomSource: new MathRandomSource(),
    sleep: sleepUnlessAborted,
    logger,
    batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
    pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
  });
  logger.info(
    {
      pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS,
      batchSize: config.OUTBOX_RELAY_BATCH_SIZE,
    },
    'outbox relay enabled',
  );
  return {
    start: () => {
      relay.start();
    },
    resources: [
      { name: 'outbox-relay', close: () => relay.stop() },
      { name: 'amqp', close: () => publisher.close() },
    ],
  };
}
