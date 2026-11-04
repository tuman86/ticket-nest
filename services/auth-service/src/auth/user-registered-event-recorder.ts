import {
  USER_REGISTERED_EVENT_TYPE,
  USER_REGISTERED_EVENT_VERSION,
  UserRegisteredEvent,
} from '@ticketnest/contracts';
import { type EventEnvelopeBuilder, type OutboxWriter } from '@ticketnest/messaging';

import { type RoleRecord } from '../repositories/role.repository';
import { type Transaction } from '../repositories/transaction';
import { type UserRecord } from '../repositories/user.repository';

/** `aggregateVersion` of the first event of a user. Registration is always that first event. */
const FIRST_AGGREGATE_VERSION = 1;

export interface UserRegisteredEventRecorderDependencies {
  readonly outboxWriter: OutboxWriter<Transaction>;
  readonly envelopeBuilder: EventEnvelopeBuilder;
  /** Where the correlation id of the current request comes from. */
  readonly readCorrelationId: () => string;
}

/** Records the `user.registered` event for a new account in the outbox. */
export class UserRegisteredEventRecorder {
  /**
   * @param dependencies - The outbox writer, the envelope builder and the correlation id source.
   */
  constructor(private readonly dependencies: UserRegisteredEventRecorderDependencies) {}

  /**
   * Writes the `user.registered` event in the transaction that creates the user, so both commit
   * or neither does. It makes no network call.
   *
   * The payload is built from the three named fields only, never by spreading the user, so the
   * email, name, phone and password hash cannot reach the event (`.claude/rules/security.md`).
   *
   * @param tx - The open transaction that holds the new user.
   * @param user - The stored user. Its creation time becomes `registeredAt`.
   * @param role - The role the account was created with.
   * @throws InvalidOutboxEventError when the event does not match its contract.
   */
  async record(tx: Transaction, user: UserRecord, role: RoleRecord): Promise<void> {
    const { outboxWriter, envelopeBuilder, readCorrelationId } = this.dependencies;
    const envelope = envelopeBuilder.build({
      type: USER_REGISTERED_EVENT_TYPE,
      version: USER_REGISTERED_EVENT_VERSION,
      aggregateId: user.id,
      aggregateVersion: FIRST_AGGREGATE_VERSION,
      correlationId: readCorrelationId(),
      tenantId: user.tenantId,
      data: {
        userId: user.id,
        roleKey: role.key,
        registeredAt: user.createdAt.toISOString(),
      },
    });
    await outboxWriter.add(tx, UserRegisteredEvent, envelope);
  }
}
