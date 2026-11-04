import { type EventEnvelope } from '@ticketnest/contracts';

/**
 * What the writer hands to the store for one event (docs/architecture.md section 8.1). The store
 * adds `created_at`, `published_at` and `attempts` itself.
 *
 * The whole envelope is the payload and the relay publishes it as is, so the message on the bus is
 * exactly what the schema accepted. The other fields repeat envelope values so the relay can order
 * and filter rows without opening the payload.
 */
export interface OutboxRow {
  /** The event id, so a consumer's inbox and the outbox dedupe on the same value. */
  readonly id: string;
  /** The first segment of the event type (`user` for `user.registered`). */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** The relay publishes the rows of one aggregate in this order. */
  readonly aggregateVersion: number;
  /** The event type, also the routing key. */
  readonly type: string;
  /** The parsed envelope. Contains no field its schema does not declare. */
  readonly payload: EventEnvelope;
}
