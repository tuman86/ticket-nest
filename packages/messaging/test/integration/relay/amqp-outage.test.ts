// Tests that break the broker or the link to it. They need a broker of their own: closing every
// connection or raising a memory alarm would disturb the tests that share the global container.
import { EventEnvelope } from '@ticketnest/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { AmqpEventPublisher } from '@/relay/amqp-event-publisher';
import { PUBLISH_CONFIRM_TIMEOUT_MS } from '@/relay/relay-constants';
import { buildEventExchangeName } from '@/topology-names';

import { buildEventId, buildStoredEvent } from '../../support/build-event';
import { createTestLogger } from '../../support/create-test-logger';
import { PausableTcpProxy } from '../../support/pausable-tcp-proxy';
import { type RunningBroker, startRabbitMqBroker } from '../../support/start-rabbitmq-broker';
import { createTestDomain, openTestConnection, sleep } from '../../support/test-amqp';

const LOOPBACK_HOST = '127.0.0.1';
const IN_FLIGHT_SETTLE_MS = 300;
const NOTICE_LOSS_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const ALARM_THRESHOLD_BYTES = '1000';
const DEFAULT_MEMORY_WATERMARK = '0.4';

let broker: RunningBroker;
let proxy: PausableTcpProxy;
let domain: string;
let publisher: AmqpEventPublisher;

beforeAll(async () => {
  broker = await startRabbitMqBroker();
  proxy = await PausableTcpProxy.start({ host: broker.amqpHost, port: broker.amqpPort });
});

afterAll(async () => {
  await proxy.stop();
  await broker.stop();
});

beforeEach(() => {
  domain = createTestDomain();
  const url = new URL(broker.amqpUrl);
  url.hostname = LOOPBACK_HOST;
  url.port = String(proxy.port);
  publisher = new AmqpEventPublisher({
    url: url.toString(),
    domain,
    logger: createTestLogger().logger,
  });
});

afterEach(async () => {
  await publisher.close();
  proxy.forward();
});

/**
 * @param sequenceNumber - A number that makes the event unique within a test.
 * @returns A valid event envelope.
 */
function buildEvent(sequenceNumber = 1): EventEnvelope {
  return EventEnvelope.parse(buildStoredEvent({ id: buildEventId(sequenceNumber) }));
}

/**
 * @param promise - A promise that is expected to reject.
 * @returns What it rejected with.
 * @throws Error when it resolves.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('The promise was expected to reject.');
}

/**
 * Publishes until the publisher notices that its connection is gone, the way the relay does tick
 * after tick. Events that still get through meanwhile are harmless duplicates.
 *
 * @throws Error when the publisher has not noticed within `NOTICE_LOSS_TIMEOUT_MS`.
 */
async function waitUntilPublisherNoticesLoss(): Promise<void> {
  const deadline = Date.now() + NOTICE_LOSS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await publisher.publish(buildEvent());
    } catch (error) {
      if (error instanceof BrokerUnavailableError) {
        return;
      }
      throw error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('The publisher never noticed that the connection was gone.');
}

/**
 * Calls `connect()` until it succeeds, the way the relay does tick after tick.
 *
 * @throws Error when it still fails after `NOTICE_LOSS_TIMEOUT_MS`.
 */
async function connectWhenPossible(): Promise<void> {
  const deadline = Date.now() + NOTICE_LOSS_TIMEOUT_MS;
  for (;;) {
    try {
      await publisher.connect();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

describe('AmqpEventPublisher when the broker or the link fails', () => {
  it('rejects a publish in flight with BrokerUnavailableError when the broker closes its connections', async () => {
    await publisher.connect();
    proxy.holdTrafficToBroker();

    const inFlight = captureRejection(publisher.publish(buildEvent()));
    await sleep(IN_FLIGHT_SETTLE_MS);
    await broker.run(['rabbitmqctl', 'close_all_connections', 'outage test']);

    expect(await inFlight).toBeInstanceOf(BrokerUnavailableError);
  });

  it('reconnects and redeclares on the next connect() after the broker closed its connections', async () => {
    await publisher.connect();
    await broker.run(['rabbitmqctl', 'close_all_connections', 'outage test']);
    await waitUntilPublisherNoticesLoss();

    await publisher.connect();

    await expect(publisher.publish(buildEvent())).resolves.toBeUndefined();
  });

  it('rejects a publish with BrokerUnavailableError after the exchange was deleted, and the next connect() declares it again', async () => {
    await publisher.connect();
    const direct = await openTestConnection(broker.amqpUrl);
    const channel = await direct.createChannel();
    await channel.deleteExchange(buildEventExchangeName(domain));
    await direct.close();

    await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);
    await publisher.connect();

    await expect(publisher.publish(buildEvent())).resolves.toBeUndefined();
  });

  it('rejects publishes with BrokerUnavailableError within the confirm timeout while a memory alarm blocks the broker', async () => {
    await publisher.connect();
    await broker.run([
      'rabbitmqctl',
      'set_vm_memory_high_watermark',
      'absolute',
      ALARM_THRESHOLD_BYTES,
    ]);
    try {
      const startedAt = Date.now();

      const error = await captureRejection(publisher.publish(buildEvent()));

      expect(error).toBeInstanceOf(BrokerUnavailableError);
      expect(Date.now() - startedAt).toBeLessThan(PUBLISH_CONFIRM_TIMEOUT_MS);
      await expect(publisher.publish(buildEvent(2))).rejects.toBeInstanceOf(BrokerUnavailableError);
      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
    } finally {
      await broker.run(['rabbitmqctl', 'set_vm_memory_high_watermark', DEFAULT_MEMORY_WATERMARK]);
    }
  });

  it('publishes again once the alarm is cleared', async () => {
    await publisher.connect();
    await broker.run([
      'rabbitmqctl',
      'set_vm_memory_high_watermark',
      'absolute',
      ALARM_THRESHOLD_BYTES,
    ]);
    try {
      await captureRejection(publisher.publish(buildEvent()));
    } finally {
      // Cleared even when the line above fails, so a failure here cannot block the next tests.
      await broker.run(['rabbitmqctl', 'set_vm_memory_high_watermark', DEFAULT_MEMORY_WATERMARK]);
    }
    await connectWhenPossible();

    await expect(publisher.publish(buildEvent(2))).resolves.toBeUndefined();
  });

  it('ends a publish with BrokerUnavailableError, not a charged failure, when the link goes silent, within the confirm timeout', async () => {
    await publisher.connect();
    proxy.blackhole();
    const startedAt = Date.now();

    const error = await captureRejection(publisher.publish(buildEvent()));

    expect(error).toBeInstanceOf(BrokerUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(PUBLISH_CONFIRM_TIMEOUT_MS);
  });

  it('reconnects through a restored link on the next connect()', async () => {
    await publisher.connect();
    proxy.blackhole();
    await captureRejection(publisher.publish(buildEvent()));
    proxy.forward();

    await publisher.connect();

    await expect(publisher.publish(buildEvent(2))).resolves.toBeUndefined();
  });
});
