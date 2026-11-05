import { type EventEnvelope } from '@ticketnest/contracts';

import { type AmqpPublishProperties } from './amqp-types';

const JSON_CONTENT_TYPE = 'application/json';

/**
 * Builds the message properties of one event (ADR-0005 section 4): persistent on a durable
 * exchange, and the event's own id, type and correlation id, so the message id is the same value as
 * the outbox row id and a consumer's inbox key. `mandatory` is deliberately absent: the alternate
 * exchange keeps an event nobody consumes yet, so the broker always routes it.
 *
 * @param event - The envelope about to be published.
 * @returns The properties to publish it with.
 */
export function buildPublishOptions(event: EventEnvelope): AmqpPublishProperties {
  return {
    persistent: true,
    contentType: JSON_CONTENT_TYPE,
    messageId: event.id,
    type: event.type,
    correlationId: event.correlationId,
  };
}
