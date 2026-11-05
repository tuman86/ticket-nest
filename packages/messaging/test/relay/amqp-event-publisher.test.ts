import { EventEnvelope } from '@ticketnest/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { PublishNotConfirmedError } from '@/publish-not-confirmed.error';
import { AmqpEventPublisher } from '@/relay/amqp-event-publisher';
import { buildPublishOptions } from '@/relay/build-publish-options';
import { InvalidBrokerUrlError } from '@/relay/invalid-broker-url.error';
import {
  AMQP_CLOSE_TIMEOUT_MS,
  AMQP_CONNECT_TIMEOUT_MS,
  AMQP_HEARTBEAT_SECONDS,
  PUBLISH_CONFIRM_TIMEOUT_MS,
} from '@/relay/relay-constants';
import { TopologyDeclarationError } from '@/relay/topology-declaration.error';

import { buildEventId, buildStoredEvent } from '../support/build-event';
import { createTestLogger } from '../support/create-test-logger';
import {
  FakeAmqpBroker,
  type FakeAmqpChannel,
  type FakeAmqpConnection,
} from '../support/fake-amqp-connection';
import { settle } from '../support/settle';

const BROKER_URL = 'amqp://relay:s3cret@broker.internal:5672/ticketnest';
const PASSWORD = 's3cret';
const CONNECTION_FORCED = 320;
const PRECONDITION_FAILED = 406;
const BATCH_SEQUENCE_NUMBERS = [1, 2, 3];
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * @param sequenceNumber - A number that makes the event unique within a test.
 * @returns A valid event envelope.
 */
function buildEvent(sequenceNumber = 1): EventEnvelope {
  return EventEnvelope.parse(buildStoredEvent({ id: buildEventId(sequenceNumber) }));
}

/**
 * @param promise - A promise that is expected to reject.
 * @returns What it rejected with, or `undefined` when it resolved.
 */
function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * @param code - An AMQP reply code.
 * @param text - What amqplib says about it.
 * @returns An error shaped like the ones amqplib raises for a close frame.
 */
function buildBrokerError(code: number, text: string): Error {
  return Object.assign(new Error(text), { code });
}

/**
 * Makes the fake broker refuse the declaration of the event exchange, as it does when the exchange
 * exists with other arguments.
 *
 * @param broker - The fake broker.
 */
function refuseEventExchange(broker: FakeAmqpBroker): void {
  broker.prepareConnection = (connection) => {
    connection.prepareChannel = (channel) => {
      channel.refuseDeclarationOf(
        'auth.events',
        buildBrokerError(PRECONDITION_FAILED, 'Operation failed: ExchangeDeclare; 406'),
      );
    };
  };
}

/**
 * Builds a publisher over a fake broker.
 *
 * @returns The publisher, the fake broker behind it and the log lines it writes.
 */
function buildPublisher() {
  const broker = new FakeAmqpBroker();
  const { logger, lines } = createTestLogger();
  const publisher = new AmqpEventPublisher({
    url: BROKER_URL,
    domain: 'auth',
    logger,
    connect: broker.connect,
  });
  return { publisher, broker, lines };
}

/**
 * Builds a publisher that has connected, and returns the fakes behind it.
 *
 * @returns The publisher, the broker, the open connection and its confirm channel.
 */
async function buildConnectedPublisher(): Promise<
  ReturnType<typeof buildPublisher> & { connection: FakeAmqpConnection; channel: FakeAmqpChannel }
> {
  const built = buildPublisher();
  await built.publisher.connect();
  const connection = built.broker.latestConnection;
  const [channel] = connection.confirmChannels;
  if (channel === undefined) {
    throw new Error('The publisher did not open a confirm channel.');
  }
  return { ...built, connection, channel };
}

describe('AmqpEventPublisher', () => {
  beforeEach(() => {
    // Only the timers the publisher uses are faked, so `settle()` still works.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('opens nothing when constructed', () => {
      const { broker } = buildPublisher();

      expect(broker.connectCalls).toEqual([]);
    });

    it('connects, declares the topology and opens the confirm channel on the first connect()', async () => {
      const { publisher, broker } = buildPublisher();

      await publisher.connect();

      const connection = broker.latestConnection;
      expect(broker.connectCalls).toHaveLength(1);
      expect(connection.channels).toHaveLength(1);
      expect(connection.channels[0]?.declarations).toHaveLength(4);
      expect(connection.channels[0]?.closeCount).toBe(1);
      expect(connection.confirmChannels).toHaveLength(1);
      expect(connection.confirmChannels[0]?.declarations).toEqual([]);
    });

    it('does nothing on a second connect() while healthy', async () => {
      const { publisher, broker } = await buildConnectedPublisher();

      await publisher.connect();

      expect(broker.connectCalls).toHaveLength(1);
    });

    it('shares one attempt between concurrent connect() calls', async () => {
      const { publisher, broker } = buildPublisher();
      const held = broker.holdNextConnect();

      const first = publisher.connect();
      const second = publisher.connect();
      held.accept();
      await Promise.all([first, second]);

      expect(broker.connectCalls).toHaveLength(1);
      expect(broker.connections).toHaveLength(1);
    });

    it('passes the heartbeat and the connection timeout to amqplib, and keeps the credentials and vhost', async () => {
      const { publisher, broker } = buildPublisher();

      await publisher.connect();

      const [call] = broker.connectCalls;
      const url = new URL(call?.url ?? '');
      expect(url.searchParams.get('heartbeat')).toBe(String(AMQP_HEARTBEAT_SECONDS));
      expect(url.username).toBe('relay');
      expect(url.password).not.toBe('');
      expect(url.pathname).toBe('/ticketnest');
      expect(call?.options).toEqual({ timeout: AMQP_CONNECT_TIMEOUT_MS });
    });

    it('rejects with BrokerUnavailableError when the broker cannot be reached', async () => {
      const { publisher, broker } = buildPublisher();
      broker.connectError = new Error('connect ECONNREFUSED 10.0.0.1:5672');

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it('rejects with BrokerUnavailableError when the handshake is refused', async () => {
      const { publisher, broker } = buildPublisher();
      broker.connectError = buildBrokerError(
        403,
        'Handshake terminated by server: 403 (ACCESS-REFUSED)',
      );

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it("keeps the driver's message, which can hold the URL, out of the error detail and the logs", async () => {
      const { publisher, broker, lines } = buildPublisher();
      broker.connectError = new Error(`connect failed for ${BROKER_URL}`);

      const error = await captureRejection(publisher.connect());

      expect(error).toBeInstanceOf(BrokerUnavailableError);
      expect((error as BrokerUnavailableError).detail).not.toContain(PASSWORD);
      expect(JSON.stringify(lines)).not.toContain(PASSWORD);
    });

    it('rejects with TopologyDeclarationError when the declaration is refused and never opens the confirm channel', async () => {
      const { publisher, broker } = buildPublisher();
      refuseEventExchange(broker);

      await expect(publisher.connect()).rejects.toBeInstanceOf(TopologyDeclarationError);

      expect(broker.latestConnection.confirmChannels).toHaveLength(0);
    });

    it('closes the connection it opened when the declaration is refused', async () => {
      const { publisher, broker } = buildPublisher();
      refuseEventExchange(broker);

      await captureRejection(publisher.connect());

      expect(broker.latestConnection.closeCount).toBe(1);
    });

    it('does not keep a session that was lost while it was opening', async () => {
      const { publisher, broker } = buildPublisher();
      broker.prepareConnection = (connection) => {
        let channelsOpened = 0;
        connection.prepareChannel = () => {
          channelsOpened += 1;
          // The second channel is the confirm channel: the connection drops as it opens.
          if (channelsOpened === 2) {
            connection.emitClose(buildBrokerError(CONNECTION_FORCED, 'Connection closed: 320'));
          }
        };
      };

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
      broker.prepareConnection = () => undefined;
      await publisher.connect();

      expect(broker.connectCalls).toHaveLength(2);
      await expect(
        (async () => {
          const publishing = publisher.publish(buildEvent());
          await settle();
          broker.latestConnection.confirmChannels[0]?.acknowledge(0);
          await publishing;
        })(),
      ).resolves.toBeUndefined();
    });

    it('rejects the connect() that opened a session the broker blocked while it was opening', async () => {
      const { publisher, broker } = buildPublisher();
      broker.prepareConnection = (connection) => {
        let channelsOpened = 0;
        connection.prepareChannel = () => {
          channelsOpened += 1;
          if (channelsOpened === 2) {
            connection.emitBlocked('low on memory');
          }
        };
      };

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
      broker.latestConnection.emitUnblocked();

      await expect(publisher.connect()).resolves.toBeUndefined();
      expect(broker.connectCalls).toHaveLength(1);
    });

    it('throws InvalidBrokerUrlError, without the URL, when the URL is invalid', () => {
      const { logger } = createTestLogger();
      const badUrl = `amqp://relay:${PASSWORD}@[bad`;

      let thrown: unknown;
      try {
        new AmqpEventPublisher({ url: badUrl, domain: 'auth', logger });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidBrokerUrlError);
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(PASSWORD);
    });

    it('tries again on the next connect() after a failed attempt', async () => {
      const { publisher, broker } = buildPublisher();
      broker.connectError = new Error('connect ECONNREFUSED');
      await captureRejection(publisher.connect());
      broker.connectError = undefined;

      await publisher.connect();

      expect(broker.connectCalls).toHaveLength(2);
      expect(broker.connections).toHaveLength(1);
    });
  });

  describe('publish', () => {
    it('rejects with BrokerUnavailableError before connect() has succeeded', async () => {
      const { publisher } = buildPublisher();

      await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it('publishes to <domain>.events with the event type as routing key and the envelope as the JSON body', async () => {
      const { publisher, channel } = await buildConnectedPublisher();
      const event = buildEvent();

      void publisher.publish(event);
      await settle();

      const [message] = channel.published;
      expect(message?.exchange).toBe('auth.events');
      expect(message?.routingKey).toBe('user.registered');
      expect(JSON.parse(message?.content.toString() ?? '')).toEqual(event);
    });

    it('sends the properties from buildPublishOptions', async () => {
      const { publisher, channel } = await buildConnectedPublisher();
      const event = buildEvent();

      void publisher.publish(event);
      await settle();

      expect(channel.published[0]?.options).toEqual(buildPublishOptions(event));
    });

    it('resolves when the broker acks', async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const publishing = publisher.publish(buildEvent());
      await settle();
      channel.acknowledge(0);

      await expect(publishing).resolves.toBeUndefined();
    });

    it("rejects with PublishNotConfirmedError('nack') on a nack", async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const publishing = captureRejection(publisher.publish(buildEvent()));
      await settle();
      channel.nack(0);

      const error = await publishing;
      expect(error).toBeInstanceOf(PublishNotConfirmedError);
      expect(error).toMatchObject({ reason: 'nack' });
    });

    it("rejects with PublishNotConfirmedError('confirm_timeout') when no answer comes within PUBLISH_CONFIRM_TIMEOUT_MS", async () => {
      const { publisher } = await buildConnectedPublisher();
      let isSettled = false;

      const publishing = captureRejection(publisher.publish(buildEvent())).then((error) => {
        isSettled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(PUBLISH_CONFIRM_TIMEOUT_MS - 1);
      expect(isSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const error = await publishing;
      expect(error).toBeInstanceOf(PublishNotConfirmedError);
      expect(error).toMatchObject({ reason: 'confirm_timeout' });
    });

    it('ignores an ack that arrives after the timeout', async () => {
      const { publisher, channel } = await buildConnectedPublisher();
      const publishing = captureRejection(publisher.publish(buildEvent()));
      await vi.advanceTimersByTimeAsync(PUBLISH_CONFIRM_TIMEOUT_MS);
      await publishing;

      expect(() => {
        channel.acknowledge(0);
      }).not.toThrow();
    });

    it('clears the timer when the publish settles', async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const publishing = publisher.publish(buildEvent());
      await settle();
      channel.acknowledge(0);
      await publishing;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the connection after a timeout and settles the other publishes on their own acks', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      const timedOut = captureRejection(publisher.publish(buildEvent(1)));
      const answered = publisher.publish(buildEvent(2));
      await settle();
      channel.acknowledge(1);
      await answered;

      await vi.advanceTimersByTimeAsync(PUBLISH_CONFIRM_TIMEOUT_MS);

      expect(await timedOut).toBeInstanceOf(PublishNotConfirmedError);
      expect(connection.closeCount).toBe(0);
      const next = publisher.publish(buildEvent(3));
      await settle();
      channel.acknowledge(2);
      await expect(next).resolves.toBeUndefined();
    });

    it('settles every publish of a batch on its own confirm, so one nack fails one', async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const batch = Promise.allSettled(
        BATCH_SEQUENCE_NUMBERS.map((sequenceNumber) =>
          publisher.publish(buildEvent(sequenceNumber)),
        ),
      );
      await settle();
      channel.acknowledge(0);
      channel.nack(1);
      channel.acknowledge(2);

      const results = await batch;
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
    });

    it("ignores the false return of amqplib's publish and does not wait for drain", async () => {
      const { publisher, channel } = await buildConnectedPublisher();
      channel.hasWriteBufferRoom = false;

      const publishing = publisher.publish(buildEvent());
      await settle();
      channel.acknowledge(0);

      await expect(publishing).resolves.toBeUndefined();
    });
  });

  describe('losing the connection', () => {
    it('rejects the publishes in flight with BrokerUnavailableError when the connection closes', async () => {
      const { publisher, connection } = await buildConnectedPublisher();

      const publishing = captureRejection(publisher.publish(buildEvent()));
      await settle();
      connection.emitClose(buildBrokerError(CONNECTION_FORCED, 'Connection closed: 320'));

      expect(await publishing).toBeInstanceOf(BrokerUnavailableError);
    });

    it('rejects them the same way when the channel closes, even when amqplib reports it through the confirm callback', async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const throughCallback = captureRejection(publisher.publish(buildEvent(1)));
      await settle();
      channel.failPendingPublishes(new Error('channel closed'));
      channel.emitClose();
      const throughEvent = captureRejection(publisher.publish(buildEvent(2)));

      expect(await throughCallback).toBeInstanceOf(BrokerUnavailableError);
      expect(await throughEvent).toBeInstanceOf(BrokerUnavailableError);
    });

    it('does not reconnect by itself', async () => {
      const { broker, connection } = await buildConnectedPublisher();

      connection.emitClose(buildBrokerError(CONNECTION_FORCED, 'Connection closed: 320'));
      await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS);

      expect(broker.connectCalls).toHaveLength(1);
    });

    it('opens a new connection and channel and redeclares on the connect() after a loss', async () => {
      const { publisher, broker, connection } = await buildConnectedPublisher();
      connection.emitClose(buildBrokerError(CONNECTION_FORCED, 'Connection closed: 320'));

      await publisher.connect();

      expect(broker.connectCalls).toHaveLength(2);
      const reopened = broker.latestConnection;
      expect(reopened).not.toBe(connection);
      expect(reopened.channels[0]?.declarations).toHaveLength(4);
      expect(reopened.confirmChannels).toHaveLength(1);
      expect(connection.closeCount).toBe(1);
    });

    it('handles the connection error event without an uncaught exception', async () => {
      const { publisher, connection } = await buildConnectedPublisher();

      const listenerCount = connection.emitError(new Error('read ECONNRESET'));

      expect(listenerCount).toBeGreaterThan(0);
      await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it('handles the channel error event without an uncaught exception', async () => {
      const { publisher, channel } = await buildConnectedPublisher();

      const listenerCount = channel.emitError(
        buildBrokerError(404, 'Channel closed by server: 404 (NOT-FOUND)'),
      );

      expect(listenerCount).toBeGreaterThan(0);
      await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it("logs a closed connection by error name and code, never the driver's message", async () => {
      const { connection, lines } = await buildConnectedPublisher();

      connection.emitClose(
        buildBrokerError(CONNECTION_FORCED, `Connection closed for ${BROKER_URL}`),
      );

      expect(lines).toContainEqual(
        expect.objectContaining({
          msg: 'broker connection closed',
          errorName: 'Error',
          replyCode: CONNECTION_FORCED,
        }),
      );
      expect(JSON.stringify(lines)).not.toContain(PASSWORD);
    });
  });

  describe('a blocked connection', () => {
    it('rejects publish() with BrokerUnavailableError while the connection is blocked', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      connection.emitBlocked('low on memory');

      await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);

      expect(channel.published).toHaveLength(0);
    });

    it('rejects connect() with BrokerUnavailableError while the connection is blocked', async () => {
      const { publisher, connection } = await buildConnectedPublisher();
      connection.emitBlocked('low on memory');

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it('rejects the publishes in flight at once when blocked fires', async () => {
      const { publisher, connection } = await buildConnectedPublisher();
      const publishing = captureRejection(publisher.publish(buildEvent()));
      await settle();

      connection.emitBlocked('low on memory');

      expect(await publishing).toBeInstanceOf(BrokerUnavailableError);
    });

    it('accepts publishes again after unblocked', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      connection.emitBlocked('low on memory');
      connection.emitUnblocked();

      await publisher.connect();
      const publishing = publisher.publish(buildEvent());
      await settle();
      channel.acknowledge(0);

      await expect(publishing).resolves.toBeUndefined();
    });

    it('logs blocked and unblocked once each', async () => {
      const { connection, lines } = await buildConnectedPublisher();

      connection.emitBlocked('low on memory');
      connection.emitUnblocked();

      expect(lines.filter((line) => line.msg === 'broker blocked the connection')).toHaveLength(1);
      expect(lines.filter((line) => line.msg === 'broker unblocked the connection')).toHaveLength(
        1,
      );
    });
  });

  describe('close', () => {
    it('closes the channel and then the connection', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      const order: string[] = [];
      channel.onClose = () => order.push('channel');
      connection.onClose = () => order.push('connection');

      await publisher.close();

      expect(order).toEqual(['channel', 'connection']);
    });

    it('rejects the publishes in flight with BrokerUnavailableError', async () => {
      const { publisher } = await buildConnectedPublisher();
      const publishing = captureRejection(publisher.publish(buildEvent()));
      await settle();

      await publisher.close();

      expect(await publishing).toBeInstanceOf(BrokerUnavailableError);
    });

    it('can be called twice', async () => {
      const { publisher, connection } = await buildConnectedPublisher();

      await publisher.close();
      await publisher.close();

      expect(connection.closeCount).toBe(1);
    });

    it('does not throw when the channel or the connection fails to close', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      channel.closeBehaviour = 'reject';
      connection.closeBehaviour = 'reject';

      await expect(publisher.close()).resolves.toBeUndefined();

      expect(connection.closeCount).toBe(1);
    });

    it('stops waiting for a close that never ends after AMQP_CLOSE_TIMEOUT_MS', async () => {
      const { publisher, channel, connection } = await buildConnectedPublisher();
      channel.closeBehaviour = 'hang';
      connection.closeBehaviour = 'hang';
      let isClosed = false;

      const closing = publisher.close().then(() => {
        isClosed = true;
      });
      await vi.advanceTimersByTimeAsync(2 * AMQP_CLOSE_TIMEOUT_MS - 1);
      expect(isClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(isClosed).toBe(true);
      expect(connection.closeCount).toBe(1);
    });

    it('cancels a connect() in flight and closes the connection it opens', async () => {
      const { publisher, broker } = buildPublisher();
      const held = broker.holdNextConnect();
      const connecting = captureRejection(publisher.connect());

      await publisher.close();
      const connection = held.accept();

      expect(await connecting).toBeInstanceOf(BrokerUnavailableError);
      expect(connection.closeCount).toBe(1);
      expect(connection.channels).toHaveLength(0);
    });

    it('makes connect() and publish() reject with BrokerUnavailableError afterwards', async () => {
      const { publisher } = await buildConnectedPublisher();
      await publisher.close();

      await expect(publisher.connect()).rejects.toBeInstanceOf(BrokerUnavailableError);
      await expect(publisher.publish(buildEvent())).rejects.toBeInstanceOf(BrokerUnavailableError);
    });
  });
});
