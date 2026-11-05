// The three assertions ADR-0005 asks for before any relay code depends on the topology, plus a few
// controls that show the assertions can fail. They use plain amqplib and no code of ours except the
// name builders, so they check what the broker does, not what we wrote. A failure here changes the
// ADR, not the test.
import { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  buildEventExchangeName,
  buildUnroutedExchangeName,
  buildUnroutedQueueName,
} from '@/topology-names';

import {
  createTestDomain,
  fetchMessages,
  openTestConnection,
  publishAndConfirm,
  readQueueDetails,
  sleep,
} from '../../support/test-amqp';

const ROUTING_KEY = 'user.registered';
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const EVENT_BODY = JSON.stringify({ id: EVENT_ID, type: ROUTING_KEY });
const PERSISTENT_DELIVERY_MODE = 2;
const NO_ROUTE_REPLY_CODE = 312;
const PRECONDITION_FAILED_REPLY_CODE = 406;

/** The values ADR-0005 gives the catch-all queue. */
const UNROUTED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNROUTED_MAX_LENGTH = 100_000;

const SHORT_TTL_MS = 1_000;
const TTL_EXPIRY_MARGIN_MS = 1_500;
const NO_MESSAGE_WAIT_MS = 1_000;
const SMALL_MAX_LENGTH = 3;
const CHANNEL_CLOSE_WAIT_MS = 2_000;
const CHANNEL_CLOSE_POLL_MS = 20;
const MESSAGE_WAIT_MS = 5_000;

const QUORUM_QUEUE_ARGUMENTS = { 'x-queue-type': 'quorum' };

interface TopologyNames {
  readonly eventExchange: string;
  readonly unroutedExchange: string;
  readonly unroutedQueue: string;
}

let connection: ChannelModel;
let domain: string;
let names: TopologyNames;

beforeAll(async () => {
  connection = await openTestConnection(inject('amqpUrl'));
});

afterAll(async () => {
  await connection.close();
});

beforeEach(() => {
  domain = createTestDomain();
  names = {
    eventExchange: buildEventExchangeName(domain),
    unroutedExchange: buildUnroutedExchangeName(domain),
    unroutedQueue: buildUnroutedQueueName(domain),
  };
});

/**
 * Opens a channel that survives a broker refusal: the broker closes a channel it refuses, and
 * amqplib raises `error` on it, which would be thrown if nothing listened.
 *
 * @returns A new channel.
 */
async function openChannel(): Promise<Channel> {
  const channel = await connection.createChannel();
  channel.on('error', () => undefined);
  return channel;
}

/**
 * Opens a confirm channel that survives a broker refusal.
 *
 * @returns A new confirm channel.
 */
async function openConfirmChannel(): Promise<ConfirmChannel> {
  const channel = await connection.createConfirmChannel();
  channel.on('error', () => undefined);
  return channel;
}

/**
 * Declares the three objects of ADR-0005 in the order the ADR gives: the alternate exchange, the
 * catch-all queue and its binding, then the event exchange last.
 *
 * @param channel - The channel to declare on.
 * @param alternateExchange - What the event exchange names as its alternate exchange, or `null`
 * for none.
 */
async function declareTopology(
  channel: Channel,
  alternateExchange: string | null = names.unroutedExchange,
): Promise<void> {
  await channel.assertExchange(names.unroutedExchange, 'fanout', { durable: true });
  await channel.assertQueue(names.unroutedQueue, {
    durable: true,
    arguments: {
      ...QUORUM_QUEUE_ARGUMENTS,
      'x-message-ttl': UNROUTED_MESSAGE_TTL_MS,
      'x-max-length': UNROUTED_MAX_LENGTH,
    },
  });
  await channel.bindQueue(names.unroutedQueue, names.unroutedExchange, '');
  await channel.assertExchange(names.eventExchange, 'topic', {
    durable: true,
    ...(alternateExchange === null
      ? {}
      : { arguments: { 'alternate-exchange': alternateExchange } }),
  });
}

/**
 * Waits for a promise that must reject.
 *
 * @param promise - A broker operation the broker is expected to refuse.
 * @returns The error it rejected with.
 * @throws Error when the promise resolves or rejects with something that is not an `Error`.
 */
async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('The operation rejected with something that is not an Error.', {
      cause: error,
    });
  }
  throw new Error('The operation was expected to be refused but succeeded.');
}

/**
 * Remembers when a channel closes.
 *
 * @param channel - The channel to watch.
 * @returns A function that waits until the channel has closed, and says whether it did.
 */
function watchChannelClose(channel: Channel): () => Promise<boolean> {
  let isClosed = false;
  channel.on('close', () => {
    isClosed = true;
  });
  return async () => {
    const deadline = Date.now() + CHANNEL_CLOSE_WAIT_MS;
    while (!isClosed && Date.now() < deadline) {
      await sleep(CHANNEL_CLOSE_POLL_MS);
    }
    return isClosed;
  };
}

describe('ADR-0005 assertion 1: exchange arguments cannot change after the first declaration', () => {
  it('accepts declaring the event exchange again with identical arguments', async () => {
    const channel = await openChannel();
    await declareTopology(channel);

    await expect(declareTopology(channel)).resolves.toBeUndefined();
  });

  it('refuses to declare the event exchange again with a different alternate-exchange and replies PRECONDITION_FAILED (406)', async () => {
    await declareTopology(await openChannel());

    const error = await captureError(
      (await openChannel()).assertExchange(names.eventExchange, 'topic', {
        durable: true,
        arguments: { 'alternate-exchange': `${names.unroutedExchange}.other` },
      }),
    );

    expect(error).toMatchObject({ code: PRECONDITION_FAILED_REPLY_CODE });
    expect(error.message).toContain("inequivalent arg 'alternate-exchange'");
  });

  it('closes the channel that made the refused declaration but not the connection', async () => {
    await declareTopology(await openChannel());
    const refused = await openChannel();
    const waitUntilClosed = watchChannelClose(refused);

    await captureError(
      refused.assertExchange(names.eventExchange, 'topic', {
        durable: true,
        arguments: { 'alternate-exchange': `${names.unroutedExchange}.other` },
      }),
    );

    expect(await waitUntilClosed()).toBe(true);
    const other = await openChannel();
    await expect(other.checkExchange(names.eventExchange)).resolves.toBeDefined();
  });

  it('refuses to declare the event exchange without the alternate-exchange once it was declared with one', async () => {
    await declareTopology(await openChannel());

    const error = await captureError(
      (await openChannel()).assertExchange(names.eventExchange, 'topic', { durable: true }),
    );

    expect(error).toMatchObject({ code: PRECONDITION_FAILED_REPLY_CODE });
    expect(error.message).toContain("inequivalent arg 'alternate-exchange'");
  });
});

describe('ADR-0005 assertion 2: a message with no bound queue reaches the catch-all queue', () => {
  it('confirms with an ack a publish that no queue is bound for', async () => {
    const channel = await openConfirmChannel();
    await declareTopology(channel);

    await expect(
      publishAndConfirm(channel, names.eventExchange, ROUTING_KEY, Buffer.from(EVENT_BODY)),
    ).resolves.toBeUndefined();
  });

  it('keeps a message with no bound queue in the catch-all queue', async () => {
    const channel = await openConfirmChannel();
    await declareTopology(channel);

    await publishAndConfirm(channel, names.eventExchange, ROUTING_KEY, Buffer.from(EVENT_BODY));

    const kept = await fetchMessages(channel, names.unroutedQueue, 1, MESSAGE_WAIT_MS);
    expect(kept).toHaveLength(1);
  });

  it('keeps the routing key, message id and body of that message', async () => {
    const channel = await openConfirmChannel();
    await declareTopology(channel);

    await publishAndConfirm(channel, names.eventExchange, ROUTING_KEY, Buffer.from(EVENT_BODY), {
      persistent: true,
      contentType: 'application/json',
      messageId: EVENT_ID,
      type: ROUTING_KEY,
    });

    const [kept] = await fetchMessages(channel, names.unroutedQueue, 1, MESSAGE_WAIT_MS);
    expect(kept?.fields.routingKey).toBe(ROUTING_KEY);
    expect(kept?.properties).toMatchObject({
      messageId: EVENT_ID,
      type: ROUTING_KEY,
      contentType: 'application/json',
      deliveryMode: PERSISTENT_DELIVERY_MODE,
    });
    expect(kept?.content.toString()).toBe(EVENT_BODY);
  });

  it('does not copy a message to the catch-all queue when a queue is bound for its routing key', async () => {
    const channel = await openConfirmChannel();
    await declareTopology(channel);
    const consumerQueue = `${domain}.consumer`;
    await channel.assertQueue(consumerQueue, { durable: true, arguments: QUORUM_QUEUE_ARGUMENTS });
    await channel.bindQueue(consumerQueue, names.eventExchange, ROUTING_KEY);

    await publishAndConfirm(channel, names.eventExchange, ROUTING_KEY, Buffer.from(EVENT_BODY));

    expect(await fetchMessages(channel, consumerQueue, 1, MESSAGE_WAIT_MS)).toHaveLength(1);
    expect((await channel.checkQueue(names.unroutedQueue)).messageCount).toBe(0);
  });

  it('confirms with an ack but drops a message with no bound queue when the exchange has no alternate exchange', async () => {
    const channel = await openConfirmChannel();
    const plainExchange = `${domain}.plain`;
    await channel.assertExchange(plainExchange, 'topic', { durable: true });
    const returnedReplyCodes: number[] = [];
    channel.on('return', (message: { fields: { replyCode: number } }) => {
      returnedReplyCodes.push(message.fields.replyCode);
    });

    await expect(
      publishAndConfirm(channel, plainExchange, ROUTING_KEY, Buffer.from(EVENT_BODY), {
        mandatory: true,
      }),
    ).resolves.toBeUndefined();

    // The broker answered with an ack although it could route the message nowhere: it said so
    // with a basic.return, which a publisher that does not set `mandatory` never sees.
    expect(returnedReplyCodes).toEqual([NO_ROUTE_REPLY_CODE]);
  });
});

describe('ADR-0005 assertion 3: the catch-all quorum queue applies its TTL and length cap', () => {
  it('declares the catch-all as a durable quorum queue', async () => {
    await declareTopology(await openChannel());

    const details = await readQueueDetails(inject('managementUrl'), names.unroutedQueue);

    expect(details).toMatchObject({ type: 'quorum', durable: true });
  });

  it('stores x-message-ttl and x-max-length on the catch-all as declared', async () => {
    await declareTopology(await openChannel());

    const details = await readQueueDetails(inject('managementUrl'), names.unroutedQueue);

    expect(details.arguments).toMatchObject({
      'x-queue-type': 'quorum',
      'x-message-ttl': UNROUTED_MESSAGE_TTL_MS,
      'x-max-length': UNROUTED_MAX_LENGTH,
    });
  });

  it('refuses to declare the catch-all again with a different x-message-ttl', async () => {
    await declareTopology(await openChannel());

    const error = await captureError(
      (await openChannel()).assertQueue(names.unroutedQueue, {
        durable: true,
        arguments: {
          ...QUORUM_QUEUE_ARGUMENTS,
          'x-message-ttl': UNROUTED_MESSAGE_TTL_MS + 1,
          'x-max-length': UNROUTED_MAX_LENGTH,
        },
      }),
    );

    expect(error).toMatchObject({ code: PRECONDITION_FAILED_REPLY_CODE });
    expect(error.message).toContain("inequivalent arg 'x-message-ttl'");
  });

  it('expires a message after the x-message-ttl of a quorum queue', async () => {
    const channel = await openConfirmChannel();
    const expiringQueue = `${domain}.expiring`;
    const keptQueue = `${domain}.kept`;
    await channel.assertQueue(expiringQueue, {
      durable: true,
      arguments: { ...QUORUM_QUEUE_ARGUMENTS, 'x-message-ttl': SHORT_TTL_MS },
    });
    // A queue with no TTL gets the same message, so an empty result below cannot be a broken read.
    await channel.assertQueue(keptQueue, { durable: true, arguments: QUORUM_QUEUE_ARGUMENTS });
    await publishAndConfirm(channel, '', expiringQueue, Buffer.from(EVENT_BODY));
    await publishAndConfirm(channel, '', keptQueue, Buffer.from(EVENT_BODY));

    await sleep(SHORT_TTL_MS + TTL_EXPIRY_MARGIN_MS);

    expect(await fetchMessages(channel, expiringQueue, 1, NO_MESSAGE_WAIT_MS)).toHaveLength(0);
    expect(await fetchMessages(channel, keptQueue, 1, MESSAGE_WAIT_MS)).toHaveLength(1);
  });

  it('drops the oldest message when a quorum queue with x-max-length is full', async () => {
    const channel = await openConfirmChannel();
    const cappedQueue = `${domain}.capped`;
    await channel.assertQueue(cappedQueue, {
      durable: true,
      arguments: { ...QUORUM_QUEUE_ARGUMENTS, 'x-max-length': SMALL_MAX_LENGTH },
    });
    for (const body of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      await publishAndConfirm(channel, '', cappedQueue, Buffer.from(body));
    }

    const kept = await fetchMessages(channel, cappedQueue, 5, NO_MESSAGE_WAIT_MS);

    expect(kept.map((message) => message.content.toString())).toEqual(['m3', 'm4', 'm5']);
  });
});
