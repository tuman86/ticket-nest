import {
  EventEnvelopeBuilder,
  OutboxWriter,
  SystemClock,
  UuidGenerator,
  type OutboxStore,
} from '@ticketnest/messaging';
import {
  FixedClock,
  InMemoryOutboxStore,
  SequentialIdGenerator,
} from '@ticketnest/messaging/testing';

import { UserRegisteredEventRecorder } from '@/auth/user-registered-event-recorder';
import { readOrCreateCorrelationId } from '@/correlation-id';
import { type Transaction } from '@/repositories/transaction';

import { type TestDatabase } from './test-database';

export const TEST_EVENT_TIME = new Date('2026-11-04T10:00:00.000Z');

export interface TestUserRegisteredRecorder {
  readonly recorder: UserRegisteredEventRecorder;
  /** The in-memory outbox the recorder writes to, unless a store was passed in. */
  readonly outbox: InMemoryOutboxStore<Transaction>;
}

/**
 * Builds the recorder on an in-memory outbox with predictable ids and a fixed clock.
 *
 * @param store - An outbox to write to instead of the in-memory one, for example one that fails.
 * @param readCorrelationId - Where the correlation id comes from. Defaults to the real reader, so
 *   an HTTP test sees the id of its own request.
 * @returns The recorder and the in-memory outbox.
 */
export function createTestUserRegisteredRecorder(
  store?: OutboxStore<Transaction>,
  readCorrelationId: () => string = readOrCreateCorrelationId,
): TestUserRegisteredRecorder {
  const outbox = new InMemoryOutboxStore<Transaction>();
  return {
    outbox,
    recorder: new UserRegisteredEventRecorder({
      outboxWriter: new OutboxWriter(store ?? outbox),
      envelopeBuilder: new EventEnvelopeBuilder({
        idGenerator: new SequentialIdGenerator(),
        clock: new FixedClock(TEST_EVENT_TIME),
      }),
      readCorrelationId,
    }),
  };
}

/**
 * Builds the recorder over the real outbox table, with real ids and time, like production.
 *
 * @param database - The test database whose outbox repository the recorder writes to.
 * @param store - An outbox to write to instead of the database one, for example one that fails.
 * @returns A recorder that inserts rows in the transaction it is given.
 */
export function createDatabaseUserRegisteredRecorder(
  database: TestDatabase,
  store: OutboxStore<Transaction> = database.outboxRepository,
): UserRegisteredEventRecorder {
  return new UserRegisteredEventRecorder({
    outboxWriter: new OutboxWriter(store),
    envelopeBuilder: new EventEnvelopeBuilder({
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    }),
    readCorrelationId: readOrCreateCorrelationId,
  });
}
