import { type EventEnvelope } from '@ticketnest/contracts';
import { type z } from 'zod';

import { InvalidOutboxEventError } from './invalid-outbox-event.error';
import { type OutboxRow } from './outbox-row';
import { type OutboxStore } from './outbox-store';

const AGGREGATE_TYPE_SEPARATOR = '.';

/**
 * Accepts only a schema that fixes `type` to a literal and declares the shape of `data`. The base
 * `EventEnvelope` has neither: its `data` is `unknown` and passes through unchanged, so it would
 * store fields (an email, a hash) that no schema ever reviewed.
 */
type DeclaredEvent<TEvent extends EventEnvelope> = string extends TEvent['type']
  ? never
  : unknown extends TEvent['data']
    ? never
    : TEvent;

/**
 * Writes events to the outbox. It is the only way a service publishes: it needs the caller's
 * transaction, so an event cannot be written without the state change it describes.
 */
export class OutboxWriter<TTransaction> {
  /**
   * @param store - The service's outbox table, behind its interface.
   */
  constructor(private readonly store: OutboxStore<TTransaction>) {}

  /**
   * Validates the event against its schema and inserts one outbox row in the caller's
   * transaction. The row holds the schema's parsed output, not the input, so a field the schema
   * does not declare (an email that slipped into `data`) is dropped before it is stored.
   *
   * Call it inside the same `UnitOfWork.run` as the state change. It does no network call.
   *
   * @param transaction - The transaction of the state change.
   * @param schema - The event's schema from `@ticketnest/contracts`, for example
   * `UserRegisteredEvent`. The base `EventEnvelope` is refused at compile time.
   * @param event - The event, usually built by `EventEnvelopeBuilder`.
   * @returns The parsed event that was stored.
   * @throws InvalidOutboxEventError when the event does not match the schema. Nothing is stored.
   */
  async add<TEvent extends EventEnvelope, TInput>(
    transaction: TTransaction,
    schema: z.ZodType<DeclaredEvent<TEvent>, TInput>,
    event: TInput,
  ): Promise<TEvent> {
    const result = schema.safeParse(event);
    if (!result.success) {
      const failedFields = result.error.issues.map((issue) => issue.path.join('.') || '(event)');
      throw new InvalidOutboxEventError(failedFields, result.error);
    }
    await this.store.insert(transaction, this.buildRow(result.data));
    return result.data;
  }

  /**
   * @param event - A parsed event.
   * @returns The outbox row that represents it.
   */
  private buildRow(event: EventEnvelope): OutboxRow {
    return {
      id: event.id,
      aggregateType: event.type.slice(0, event.type.indexOf(AGGREGATE_TYPE_SEPARATOR)),
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      type: event.type,
      payload: event,
    };
  }
}
