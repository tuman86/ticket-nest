import { UserRegisteredEvent } from '@ticketnest/contracts';
import { InternalServerError } from '@ticketnest/errors';
import { describe, expect, it } from 'vitest';

import { OutboxWriter } from '@/outbox-writer';

import { InMemoryOutboxStore } from './support/in-memory-outbox-store';

const USER_ID = '0b9c5b0e-6a0d-4c2b-9d5e-3f1d6a7c8e90';
const EVENT_ID = '5d0f8f55-3d1c-4b0a-8a53-2f7b9c1e4a11';

interface FakeTransaction {
  readonly name: string;
}

/**
 * @param overrides - Fields that replace the valid ones, to break one rule at a time.
 * @returns A valid `user.registered` event.
 */
function buildEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type: 'user.registered',
    version: 1,
    occurredAt: '2026-11-04T10:00:00Z',
    aggregateId: USER_ID,
    aggregateVersion: 1,
    correlationId: 'req-123',
    causationId: null,
    tenantId: null,
    data: { userId: USER_ID, roleKey: 'CUSTOMER', registeredAt: '2026-11-04T10:00:00Z' },
    ...overrides,
  };
}

/**
 * @returns A writer and the in-memory store it writes to.
 */
function buildWriter(): { writer: OutboxWriter<FakeTransaction>; store: InMemoryOutboxStore } {
  const store = new InMemoryOutboxStore<FakeTransaction>();
  return { writer: new OutboxWriter(store), store };
}

describe('OutboxWriter', () => {
  it('stores one row for the event, using the event id as the row id', async () => {
    const { writer, store } = buildWriter();

    await writer.add({ name: 'tx' }, UserRegisteredEvent, buildEvent());

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      id: EVENT_ID,
      aggregateType: 'user',
      aggregateId: USER_ID,
      aggregateVersion: 1,
      type: 'user.registered',
    });
  });

  it('hands the caller transaction to the store, so the row commits with the state change', async () => {
    const { writer, store } = buildWriter();
    const transaction = { name: 'caller transaction' };

    await writer.add(transaction, UserRegisteredEvent, buildEvent());

    expect(store.transactions).toEqual([transaction]);
    expect(store.transactions[0]).toBe(transaction);
  });

  it('stores the parsed event, so a field the schema does not know never reaches the outbox', async () => {
    const { writer, store } = buildWriter();
    const data = {
      userId: USER_ID,
      roleKey: 'CUSTOMER',
      registeredAt: '2026-11-04T10:00:00Z',
      email: 'someone@example.com',
      passwordHash: '$argon2id$v=19$secret',
    };

    await writer.add({ name: 'tx' }, UserRegisteredEvent, buildEvent({ data }));

    const storedData = store.rows[0]?.payload.data as Record<string, unknown>;
    expect(Object.keys(storedData).sort()).toEqual(['registeredAt', 'roleKey', 'userId']);
    expect(JSON.stringify(store.rows[0])).not.toContain('someone@example.com');
  });

  it('returns the parsed event', async () => {
    const { writer } = buildWriter();

    const event = await writer.add({ name: 'tx' }, UserRegisteredEvent, buildEvent());

    expect(event.data.userId).toBe(USER_ID);
  });

  it('rejects an event that does not match its schema and stores nothing', async () => {
    const { writer, store } = buildWriter();

    await expect(
      writer.add({ name: 'tx' }, UserRegisteredEvent, buildEvent({ aggregateId: 'someone-else' })),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(store.rows).toHaveLength(0);
  });

  it('names the failed field but not the event content in the error', async () => {
    const { writer } = buildWriter();

    const rejection = expect(
      writer.add({ name: 'tx' }, UserRegisteredEvent, buildEvent({ correlationId: '' })),
    ).rejects;

    await rejection.toThrow('correlationId');
    await rejection.not.toThrow(USER_ID);
  });
});
