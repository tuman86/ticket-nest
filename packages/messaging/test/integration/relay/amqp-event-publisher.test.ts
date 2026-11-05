import { EventEnvelope } from '@ticketnest/contracts';
import { type Channel, type ChannelModel } from 'amqplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { AmqpEventPublisher } from '@/relay/amqp-event-publisher';
import { buildPublishOptions } from '@/relay/build-publish-options';
import { UNROUTED_QUEUE_MAX_LENGTH, UNROUTED_QUEUE_MESSAGE_TTL_MS } from '@/relay/relay-constants';
import { TopologyDeclarationError } from '@/relay/topology-declaration.error';
import {
  buildEventExchangeName,
  buildUnroutedExchangeName,
  buildUnroutedQueueName,
} from '@/topology-names';

import { buildEventId, buildStoredEvent } from '../../support/build-event';
import { createTestLogger, type LogLine } from '../../support/create-test-logger';
import {
  createTestDomain,
  createVhost,
  fetchMessages,
  openTestConnection,
  readQueueDetails,
  waitForConnectionCount,
} from '../../support/test-amqp';

const ROUTING_KEY = 'user.registered';
const PERSISTENT_DELIVERY_MODE = 2;
const MESSAGE_WAIT_MS = 10_000;
const FULL_BATCH_SIZE = 500;
const UNREACHABLE_PORT = '1';
const WRONG_PASSWORD = 'not-the-password-of-guest';

let amqpUrl: string;
let testConnection: ChannelModel;
let testChannel: Channel;
let domain: string;
let publisher: AmqpEventPublisher;
let logLines: LogLine[];

/**
 * @param sequenceNumber - A number that makes the event unique within a test.
 * @returns A valid event envelope.
 */
function buildEvent(sequenceNumber = 1): EventEnvelope {
  return EventEnvelope.parse(buildStoredEvent({ id: buildEventId(sequenceNumber) }));
}

/**
 * @param url - The broker URL to publish through. Defaults to the container's.
 * @returns A publisher for the current test's domain, whose logs are collected in `logLines`.
 */
function buildPublisher(url: string = amqpUrl): AmqpEventPublisher {
  const { logger, lines } = createTestLogger();
  logLines = lines;
  return new AmqpEventPublisher({ url, domain, logger });
}

/**
 * @param change - What to change in the container's URL.
 * @returns A copy of the broker URL with that change.
 */
function changeBrokerUrl(change: (url: URL) => void): string {
  const url = new URL(amqpUrl);
  change(url);
  return url.toString();
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
 * @param error - An error, or whatever was thrown.
 * @returns The message of the error and of every error in its `cause` chain, for a check that no
 * driver error along the way repeats a secret.
 */
function listMessagesInCauseChain(error: unknown): string[] {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

/**
 * Declares, as another client would, a queue bound to the event exchange, so a published event has
 * somewhere to go other than the catch-all.
 *
 * @param queueName - The queue to create and bind for `user.registered`.
 */
async function bindConsumerQueue(queueName: string): Promise<void> {
  await testChannel.assertQueue(queueName, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await testChannel.bindQueue(queueName, buildEventExchangeName(domain), ROUTING_KEY);
}

beforeAll(async () => {
  amqpUrl = inject('amqpUrl');
  testConnection = await openTestConnection(amqpUrl);
  testChannel = await testConnection.createChannel();
  testChannel.on('error', () => undefined);
});

afterAll(async () => {
  await testConnection.close();
});

beforeEach(() => {
  domain = createTestDomain();
  publisher = buildPublisher();
});

afterEach(async () => {
  await publisher.close();
});

describe('AmqpEventPublisher against RabbitMQ', () => {
  it('declares the exchange, the alternate exchange and the catch-all queue on connect', async () => {
    await publisher.connect();

    await expect(testChannel.checkExchange(buildEventExchangeName(domain))).resolves.toBeDefined();
    const checker = await testConnection.createChannel();
    await expect(checker.checkExchange(buildUnroutedExchangeName(domain))).resolves.toBeDefined();
    const details = await readQueueDetails(inject('managementUrl'), buildUnroutedQueueName(domain));
    expect(details).toMatchObject({
      type: 'quorum',
      durable: true,
      arguments: {
        'x-message-ttl': UNROUTED_QUEUE_MESSAGE_TTL_MS,
        'x-max-length': UNROUTED_QUEUE_MAX_LENGTH,
      },
    });
  });

  it('connects twice without error', async () => {
    await publisher.connect();

    await expect(publisher.connect()).resolves.toBeUndefined();
  });

  it('delivers an event to a queue bound for its routing key with the envelope as the body', async () => {
    await publisher.connect();
    const consumerQueue = `${domain}.consumer`;
    await bindConsumerQueue(consumerQueue);
    const event = buildEvent();

    await publisher.publish(event);

    const [delivered] = await fetchMessages(testChannel, consumerQueue, 1, MESSAGE_WAIT_MS);
    expect(JSON.parse(delivered?.content.toString() ?? '')).toEqual(event);
  });

  it('sets persistent, content type, message id, type and correlation id on the delivered message', async () => {
    await publisher.connect();
    const consumerQueue = `${domain}.consumer`;
    await bindConsumerQueue(consumerQueue);
    const event = buildEvent();

    await publisher.publish(event);

    const [delivered] = await fetchMessages(testChannel, consumerQueue, 1, MESSAGE_WAIT_MS);
    const expected = buildPublishOptions(event);
    expect(delivered?.fields.routingKey).toBe(ROUTING_KEY);
    expect(delivered?.properties).toMatchObject({
      deliveryMode: PERSISTENT_DELIVERY_MODE,
      contentType: expected.contentType,
      messageId: expected.messageId,
      type: expected.type,
      correlationId: expected.correlationId,
    });
  });

  it('routes an event with no bound queue to the catch-all queue and confirms it', async () => {
    await publisher.connect();
    const event = buildEvent();

    await expect(publisher.publish(event)).resolves.toBeUndefined();

    const kept = await fetchMessages(
      testChannel,
      buildUnroutedQueueName(domain),
      1,
      MESSAGE_WAIT_MS,
    );
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]?.content.toString() ?? '')).toEqual(event);
  });

  it('publishes a full batch of 500 events at once and confirms every one', async () => {
    await publisher.connect();
    const batch = Array.from({ length: FULL_BATCH_SIZE }, (_, index) => buildEvent(index + 1));

    await expect(Promise.all(batch.map((event) => publisher.publish(event)))).resolves.toHaveLength(
      FULL_BATCH_SIZE,
    );

    const kept = await fetchMessages(
      testChannel,
      buildUnroutedQueueName(domain),
      FULL_BATCH_SIZE,
      MESSAGE_WAIT_MS,
    );
    expect(kept).toHaveLength(FULL_BATCH_SIZE);
  });

  it('rejects connect() with TopologyDeclarationError (code 406) when the exchange exists with other arguments', async () => {
    await testChannel.assertExchange(buildEventExchangeName(domain), 'topic', { durable: true });

    const error = await captureRejection(publisher.connect());

    expect(error).toBeInstanceOf(TopologyDeclarationError);
    expect(error).toMatchObject({
      objectName: buildEventExchangeName(domain),
      replyCode: 406,
    });
    expect((error as TopologyDeclarationError).brokerReply).toContain(
      "inequivalent arg 'alternate-exchange'",
    );
  });

  it('publishes nothing after that refusal', async () => {
    await testChannel.assertExchange(buildEventExchangeName(domain), 'topic', { durable: true });
    await captureRejection(publisher.connect());

    await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);

    const queue = await testConnection.createChannel();
    const caught = await queue.checkQueue(buildUnroutedQueueName(domain));
    expect(caught.messageCount).toBe(0);
  });

  it('connects when another client declared the same exchange with identical arguments', async () => {
    const eventExchange = buildEventExchangeName(domain);
    const alternateExchange = buildUnroutedExchangeName(domain);
    const unroutedQueue = buildUnroutedQueueName(domain);
    await testChannel.assertExchange(alternateExchange, 'fanout', { durable: true });
    await testChannel.assertQueue(unroutedQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': UNROUTED_QUEUE_MESSAGE_TTL_MS,
        'x-max-length': UNROUTED_QUEUE_MAX_LENGTH,
      },
    });
    await testChannel.bindQueue(unroutedQueue, alternateExchange, '');
    await testChannel.assertExchange(eventExchange, 'topic', {
      durable: true,
      arguments: { 'alternate-exchange': alternateExchange },
    });

    await expect(publisher.connect()).resolves.toBeUndefined();
  });

  it('rejects connect() with BrokerUnavailableError when nothing listens on the port', async () => {
    publisher = buildPublisher(
      changeBrokerUrl((url) => {
        url.port = UNREACHABLE_PORT;
      }),
    );

    await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('rejects connect() with BrokerUnavailableError when the credentials are wrong', async () => {
    publisher = buildPublisher(
      changeBrokerUrl((url) => {
        url.password = WRONG_PASSWORD;
      }),
    );

    await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it('keeps the password out of the error and its detail', async () => {
    publisher = buildPublisher(
      changeBrokerUrl((url) => {
        url.password = WRONG_PASSWORD;
      }),
    );

    const error = await captureRejection(publisher.connect());

    expect(error).toBeInstanceOf(BrokerUnavailableError);
    expect((error as BrokerUnavailableError).detail).not.toContain(WRONG_PASSWORD);
    expect(listMessagesInCauseChain(error).join('\n')).not.toContain(WRONG_PASSWORD);
    expect(JSON.stringify(logLines)).not.toContain(WRONG_PASSWORD);
  });

  it('uses the vhost named in the URL path', async () => {
    const vhost = `${domain}_vhost`;
    await createVhost(inject('managementUrl'), vhost);
    publisher = buildPublisher(
      changeBrokerUrl((url) => {
        url.pathname = `/${encodeURIComponent(vhost)}`;
      }),
    );

    await publisher.connect();

    const inVhost = await openTestConnection(
      changeBrokerUrl((url) => {
        url.pathname = `/${encodeURIComponent(vhost)}`;
      }),
    );
    const channel = await inVhost.createChannel();
    await expect(channel.checkExchange(buildEventExchangeName(domain))).resolves.toBeDefined();
    await inVhost.close();
    // The default vhost never got the exchange: the broker refuses the check.
    const otherChannel = await testConnection.createChannel();
    otherChannel.on('error', () => undefined);
    await expect(otherChannel.checkExchange(buildEventExchangeName(domain))).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('leaves no connection open on the broker after close()', async () => {
    const vhost = `${domain}_vhost`;
    await createVhost(inject('managementUrl'), vhost);
    publisher = buildPublisher(
      changeBrokerUrl((url) => {
        url.pathname = `/${encodeURIComponent(vhost)}`;
      }),
    );
    await publisher.connect();
    expect(await waitForConnectionCount(inject('managementUrl'), vhost, 1)).toBe(1);

    await publisher.close();

    expect(await waitForConnectionCount(inject('managementUrl'), vhost, 0)).toBe(0);
  });
});
