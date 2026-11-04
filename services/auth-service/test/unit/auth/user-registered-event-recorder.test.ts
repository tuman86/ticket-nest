import { UserRegisteredEvent } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { type Transaction } from '@/repositories/transaction';
import { type UserRecord } from '@/repositories/user.repository';

import {
  createTestUserRegisteredRecorder,
  TEST_EVENT_TIME,
} from '../../support/create-user-registered-event-recorder';
import { CUSTOMER_ROLE } from '../../support/in-memory-repositories';

const USER_ID = '0b9c5b0e-6a0d-4c2b-9d5e-3f1d6a7c8e90';
const TENANT_ID = '7c1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f';
const TRANSACTION: Transaction = { isTransaction: true };

/**
 * @param overrides - Fields to change from the defaults.
 * @returns A stored user with every personal field filled in, so a leak would show.
 */
function buildUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: USER_ID,
    email: 'asha.rao@example.com',
    emailVerifiedAt: null,
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    name: 'Asha Rao',
    phone: '+919876543210',
    roleId: CUSTOMER_ROLE.id,
    tenantId: null,
    status: 'ACTIVE',
    createdAt: new Date('2026-11-04T09:59:59.123Z'),
    updatedAt: new Date('2026-11-04T09:59:59.123Z'),
    ...overrides,
  };
}

describe('UserRegisteredEventRecorder.record', () => {
  it('writes one outbox row for the user', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      aggregateType: 'user',
      aggregateId: USER_ID,
      aggregateVersion: 1,
      type: 'user.registered',
    });
  });

  it('writes an event that its contract accepts', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    expect(UserRegisteredEvent.safeParse(outbox.rows[0]?.payload).success).toBe(true);
  });

  it('carries the user id, the role key and the creation time of the stored user', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    expect(outbox.rows[0]?.payload.data).toEqual({
      userId: USER_ID,
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T09:59:59.123Z',
    });
    expect(outbox.rows[0]?.payload.occurredAt).toBe(TEST_EVENT_TIME.toISOString());
  });

  it('puts only the three expected keys in the payload data', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    const data = outbox.rows[0]?.payload.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['registeredAt', 'roleKey', 'userId']);
  });

  it('keeps the email, name, phone, password hash and role id out of the whole row', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();
    const user = buildUser();

    await recorder.record(TRANSACTION, user, CUSTOMER_ROLE);

    const stored = JSON.stringify(outbox.rows);
    for (const secret of [user.email, user.name, user.phone, user.passwordHash, user.roleId]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('uses the transaction it is given, so the row commits with the user', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder();

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    expect(outbox.transactions).toHaveLength(1);
    expect(outbox.transactions[0]).toBe(TRANSACTION);
  });

  it('takes the correlation id from the request context', async () => {
    const { recorder, outbox } = createTestUserRegisteredRecorder(undefined, () => 'req-abc-123');

    await recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);

    expect(outbox.rows[0]?.payload.correlationId).toBe('req-abc-123');
    expect(outbox.rows[0]?.payload.causationId).toBeNull();
  });

  it('carries the tenant of the user, and null for a customer', async () => {
    const customer = createTestUserRegisteredRecorder();
    const operator = createTestUserRegisteredRecorder();

    await customer.recorder.record(TRANSACTION, buildUser(), CUSTOMER_ROLE);
    await operator.recorder.record(TRANSACTION, buildUser({ tenantId: TENANT_ID }), CUSTOMER_ROLE);

    expect(customer.outbox.rows[0]?.payload.tenantId).toBeNull();
    expect(operator.outbox.rows[0]?.payload.tenantId).toBe(TENANT_ID);
  });
});
