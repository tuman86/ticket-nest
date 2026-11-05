import { describe, expect, it } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { InvalidEventDomainError } from '@/invalid-event-domain.error';
import { declareEventTopology } from '@/relay/amqp-topology';
import { UNROUTED_QUEUE_MAX_LENGTH, UNROUTED_QUEUE_MESSAGE_TTL_MS } from '@/relay/relay-constants';
import { TopologyDeclarationError } from '@/relay/topology-declaration.error';

import { FakeAmqpChannel } from '../support/fake-amqp-connection';

const ALTERNATE_EXCHANGE = 'auth.events.unrouted';
const UNROUTED_QUEUE = 'auth.unrouted';
const EVENT_EXCHANGE = 'auth.events';
const PRECONDITION_FAILED = 406;
const ACCESS_REFUSED = 403;
const CONNECTION_FORCED = 320;

/**
 * @param code - An AMQP reply code.
 * @param text - What amqplib says about it.
 * @returns An error shaped like the ones amqplib raises for a close frame.
 */
function buildBrokerError(code: number, text: string): Error {
  return Object.assign(new Error(text), { code });
}

/**
 * @param channel - A fake channel the topology was declared on.
 * @returns Each declaration as `method:object`, in call order.
 */
function listDeclarations(channel: FakeAmqpChannel): string[] {
  return channel.declarations.map((call) => {
    switch (call.method) {
      case 'assertExchange':
        return `assertExchange:${call.exchange}`;
      case 'assertQueue':
      case 'bindQueue':
        return `${call.method}:${call.queue}`;
    }
  });
}

describe('declareEventTopology', () => {
  it('declares the alternate exchange, then the catch-all queue, then its binding, then the event exchange, in that order', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    expect(listDeclarations(channel)).toEqual([
      `assertExchange:${ALTERNATE_EXCHANGE}`,
      `assertQueue:${UNROUTED_QUEUE}`,
      `bindQueue:${UNROUTED_QUEUE}`,
      `assertExchange:${EVENT_EXCHANGE}`,
    ]);
  });

  it('declares the alternate exchange as a durable fanout named <domain>.events.unrouted', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    expect(channel.declarations[0]).toEqual({
      method: 'assertExchange',
      exchange: ALTERNATE_EXCHANGE,
      type: 'fanout',
      options: { durable: true },
    });
  });

  it('declares the catch-all as a durable quorum queue with the 7-day TTL and the length cap', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    expect(channel.declarations[1]).toEqual({
      method: 'assertQueue',
      queue: UNROUTED_QUEUE,
      options: {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': UNROUTED_QUEUE_MESSAGE_TTL_MS,
          'x-max-length': UNROUTED_QUEUE_MAX_LENGTH,
        },
      },
    });
  });

  it('binds the catch-all to the alternate exchange', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    expect(channel.declarations[2]).toEqual({
      method: 'bindQueue',
      queue: UNROUTED_QUEUE,
      source: ALTERNATE_EXCHANGE,
      pattern: '',
    });
  });

  it('declares the event exchange as a durable topic whose alternate-exchange is the alternate exchange', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    expect(channel.declarations[3]).toEqual({
      method: 'assertExchange',
      exchange: EVENT_EXCHANGE,
      type: 'topic',
      options: { durable: true, arguments: { 'alternate-exchange': ALTERNATE_EXCHANGE } },
    });
  });

  it('declares nothing for a consumer', async () => {
    const channel = new FakeAmqpChannel();

    await declareEventTopology(channel, 'auth');

    const queues = channel.declarations.filter((call) => call.method !== 'assertExchange');
    expect(queues.map((call) => call.queue)).toEqual([UNROUTED_QUEUE, UNROUTED_QUEUE]);
    expect(channel.declarations).toHaveLength(4);
  });

  it('rejects an invalid domain before declaring anything', async () => {
    const channel = new FakeAmqpChannel();

    await expect(declareEventTopology(channel, 'Auth')).rejects.toBeInstanceOf(
      InvalidEventDomainError,
    );
    expect(channel.declarations).toEqual([]);
  });

  it('turns a 406 refusal into a TopologyDeclarationError with the object name, code and reply text', async () => {
    const channel = new FakeAmqpChannel();
    const refusal = buildBrokerError(
      PRECONDITION_FAILED,
      'Operation failed: ExchangeDeclare; 406 (PRECONDITION-FAILED) with message "PRECONDITION_FAILED - inequivalent arg \'alternate-exchange\'"',
    );
    channel.refuseDeclarationOf(EVENT_EXCHANGE, refusal);

    const error = await declareEventTopology(channel, 'auth').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TopologyDeclarationError);
    expect(error).toMatchObject({
      objectName: EVENT_EXCHANGE,
      replyCode: PRECONDITION_FAILED,
      brokerReply: refusal.message,
      cause: refusal,
    });
  });

  it('turns a 403 refusal into a TopologyDeclarationError', async () => {
    const channel = new FakeAmqpChannel();
    channel.refuseDeclarationOf(
      UNROUTED_QUEUE,
      buildBrokerError(ACCESS_REFUSED, 'Operation failed: QueueDeclare; 403 (ACCESS-REFUSED)'),
    );

    const error = await declareEventTopology(channel, 'auth').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TopologyDeclarationError);
    expect(error).toMatchObject({ objectName: UNROUTED_QUEUE, replyCode: ACCESS_REFUSED });
  });

  it('leaves a closed connection as a BrokerUnavailableError', async () => {
    const closedByBroker = new FakeAmqpChannel();
    const cause = buildBrokerError(
      CONNECTION_FORCED,
      'Connection closed: 320 (CONNECTION-FORCED) with message "broker shutdown"',
    );
    closedByBroker.refuseDeclarationOf(ALTERNATE_EXCHANGE, cause);
    const resetSocket = new FakeAmqpChannel();
    resetSocket.refuseDeclarationOf(ALTERNATE_EXCHANGE, new Error('read ECONNRESET'));

    const forced = await declareEventTopology(closedByBroker, 'auth').catch(
      (caught: unknown) => caught,
    );
    const reset = await declareEventTopology(resetSocket, 'auth').catch(
      (caught: unknown) => caught,
    );

    expect(forced).toBeInstanceOf(BrokerUnavailableError);
    expect(forced).toMatchObject({ cause });
    expect(reset).toBeInstanceOf(BrokerUnavailableError);
  });

  it('stops at the first refusal and declares nothing after it', async () => {
    const channel = new FakeAmqpChannel();
    channel.refuseDeclarationOf(
      UNROUTED_QUEUE,
      buildBrokerError(PRECONDITION_FAILED, 'Operation failed: QueueDeclare; 406'),
    );

    await expect(declareEventTopology(channel, 'auth')).rejects.toBeInstanceOf(
      TopologyDeclarationError,
    );

    expect(listDeclarations(channel)).toEqual([
      `assertExchange:${ALTERNATE_EXCHANGE}`,
      `assertQueue:${UNROUTED_QUEUE}`,
    ]);
  });
});
