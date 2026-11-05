import { BrokerUnavailableError } from '../broker-unavailable.error';
import {
  buildEventExchangeName,
  buildUnroutedExchangeName,
  buildUnroutedQueueName,
} from '../topology-names';

import { type AmqpChannelLike } from './amqp-types';
import { readReplyCode } from './read-reply-code';
import { UNROUTED_QUEUE_MAX_LENGTH, UNROUTED_QUEUE_MESSAGE_TTL_MS } from './relay-constants';
import { TopologyDeclarationError } from './topology-declaration.error';

/** The channel operations a declaration needs. */
export type TopologyChannel = Pick<AmqpChannelLike, 'assertExchange' | 'assertQueue' | 'bindQueue'>;

const ACCESS_REFUSED = 403;
const NOT_FOUND = 404;
const RESOURCE_LOCKED = 405;
const PRECONDITION_FAILED = 406;

/**
 * The replies with which a broker refuses one operation and closes only that channel. They mean the
 * declaration itself is wrong (other arguments, no permission), so repeating it fails the same way.
 * Any other failure, a closed connection or a socket error, is a lost connection.
 */
const CHANNEL_REFUSAL_REPLY_CODES: ReadonlySet<number> = new Set([
  ACCESS_REFUSED,
  NOT_FOUND,
  RESOURCE_LOCKED,
  PRECONDITION_FAILED,
]);

/**
 * Runs one declaration and says what a failure means to the relay.
 *
 * @param objectName - The exchange or queue the declaration is about.
 * @param declaration - The channel call to make.
 * @throws TopologyDeclarationError when the broker refused this declaration (403, 404, 405, 406).
 * @throws BrokerUnavailableError for any other failure, which means the connection is lost.
 */
async function declareObject(
  objectName: string,
  declaration: () => Promise<unknown>,
): Promise<void> {
  try {
    await declaration();
  } catch (error) {
    const replyCode = readReplyCode(error);
    if (
      error instanceof Error &&
      replyCode !== undefined &&
      CHANNEL_REFUSAL_REPLY_CODES.has(replyCode)
    ) {
      throw new TopologyDeclarationError({
        objectName,
        replyCode,
        brokerReply: error.message,
        cause: error,
      });
    }
    throw new BrokerUnavailableError(error);
  }
}

/**
 * Declares everything a producing domain publishes to (ADR-0005). The order is part of the design:
 * the alternate exchange and the catch-all queue come first, and the event exchange last, so the
 * event exchange never exists without the place its unrouted messages go. Declaring is idempotent
 * while the arguments are equal, so it is repeated on every connect and needs no existence check.
 *
 * The arguments of an exchange or queue cannot change once it exists. A changed argument is refused
 * by the broker (`PRECONDITION_FAILED`) and is a topology migration for a person, not something to
 * work around.
 *
 * @param channel - A channel used for declarations only. The broker closes a channel it refuses,
 * so it must not be the channel that publishes.
 * @param domain - The producing domain, lower-case letters and underscores (`auth`).
 * @throws InvalidEventDomainError when the domain is not valid. Nothing is declared.
 * @throws TopologyDeclarationError when the broker refuses a declaration. Nothing after it is declared.
 * @throws BrokerUnavailableError when the connection is lost during the declaration.
 */
export async function declareEventTopology(
  channel: TopologyChannel,
  domain: string,
): Promise<void> {
  const alternateExchange = buildUnroutedExchangeName(domain);
  const unroutedQueue = buildUnroutedQueueName(domain);
  const eventExchange = buildEventExchangeName(domain);

  await declareObject(alternateExchange, () =>
    channel.assertExchange(alternateExchange, 'fanout', { durable: true }),
  );
  await declareObject(unroutedQueue, () =>
    channel.assertQueue(unroutedQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': UNROUTED_QUEUE_MESSAGE_TTL_MS,
        'x-max-length': UNROUTED_QUEUE_MAX_LENGTH,
      },
    }),
  );
  await declareObject(unroutedQueue, () => channel.bindQueue(unroutedQueue, alternateExchange, ''));
  await declareObject(eventExchange, () =>
    channel.assertExchange(eventExchange, 'topic', {
      durable: true,
      arguments: { 'alternate-exchange': alternateExchange },
    }),
  );
}
