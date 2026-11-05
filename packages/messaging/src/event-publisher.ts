import { type EventEnvelope } from '@ticketnest/contracts';

/**
 * Sends events to the broker. Only the outbox relay uses it; services and controllers never do
 * (`.claude/rules/data-access.md`): they write an outbox row instead. An implementation is built
 * for one producing domain and publishes every event to that domain's exchange (ADR-0005).
 */
export interface EventPublisher {
  /**
   * Makes sure the connection and the domain's topology are ready. Idempotent: it does nothing when
   * they already are, and it reconnects after a loss. It never reconnects on its own, so the caller
   * (the relay loop) calls it again after a failure and owns the backoff.
   *
   * @throws BrokerUnavailableError when the broker cannot be reached, the connection is lost or the
   * broker is blocking it.
   * @throws TopologyDeclarationError (from `@ticketnest/messaging/relay`) when the broker refuses to
   * declare the topology. That does not go away by itself: a person fixes the topology or the
   * permissions.
   */
  connect: () => Promise<void>;

  /**
   * Publishes the event with its type as routing key and resolves only once the broker has
   * confirmed it. Delivery is at-least-once, so a caller may publish the same event twice.
   *
   * An implementation must settle, by confirming or rejecting, within `PUBLISH_CONFIRM_TIMEOUT_MS`
   * and reject with `PublishNotConfirmedError` (`confirm_timeout`) when the time runs out. The
   * relay also enforces that limit itself, but only as a safety net: it abandons the publish, it
   * cannot cancel it.
   *
   * @param event - The event to send.
   * @throws PublishNotConfirmedError when the connection is up but the broker nacked the event or
   * did not confirm it in time.
   * @throws BrokerUnavailableError when the connection or channel is closed, or the broker is
   * blocking the connection (a memory or disk alarm). No attempt is charged for it.
   */
  publish: (event: EventEnvelope) => Promise<void>;
}
