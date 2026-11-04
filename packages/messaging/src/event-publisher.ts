import { type EventEnvelope } from '@ticketnest/contracts';

/**
 * Sends one event to the broker. Only the outbox relay uses it; services and controllers never do
 * (`.claude/rules/data-access.md`): they write an outbox row instead.
 */
export interface EventPublisher {
  /**
   * Publishes the event with the event type as routing key and resolves only once the broker has
   * confirmed it. The promise rejects when the broker does not confirm, so the caller can retry.
   * Delivery is at-least-once, so a caller may publish the same event twice.
   *
   * @param exchange - Topic exchange of the producing domain, from `buildEventExchangeName`.
   * @param event - The event to send.
   */
  publish: (exchange: string, event: EventEnvelope) => Promise<void>;
}
