import { randomUUID } from 'node:crypto';

import { type OutboxRow } from '@ticketnest/messaging';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type Transaction } from '@/repositories/transaction';

import { buildUserInput, createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
});

/**
 * @param overrides - Fields to change from the defaults.
 * @returns An outbox row for a `user.registered` event with a unique id.
 */
function buildRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const id = overrides.id ?? randomUUID();
  const aggregateId = overrides.aggregateId ?? randomUUID();
  return {
    id,
    aggregateType: 'user',
    aggregateId,
    aggregateVersion: 1,
    type: 'user.registered',
    payload: {
      id,
      type: 'user.registered',
      version: 1,
      occurredAt: '2026-11-04T10:00:00.000Z',
      aggregateId,
      aggregateVersion: 1,
      correlationId: 'req-123',
      causationId: null,
      tenantId: null,
      data: { userId: aggregateId, roleKey: 'CUSTOMER', registeredAt: '2026-11-04T10:00:00.000Z' },
    },
    ...overrides,
  };
}

describe('PrismaOutboxRepository.insert', () => {
  it('stores an unpublished row with the envelope as payload', async () => {
    const row = buildRow();

    await database.unitOfWork.run((tx) => database.outboxRepository.insert(tx, row));

    const stored = await database.prisma.outbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({
      id: row.id,
      aggregateType: 'user',
      aggregateId: row.aggregateId,
      aggregateVersion: 1,
      type: 'user.registered',
      payload: row.payload,
      publishedAt: null,
      attempts: 0,
    });
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('commits the row together with the user written in the same transaction', async () => {
    const roleId = await database.findRoleId('CUSTOMER');
    const row = buildRow();

    await database.unitOfWork.run(async (tx) => {
      await database.userRepository.create(buildUserInput(roleId), tx);
      await database.outboxRepository.insert(tx, row);
    });

    expect(await database.prisma.user.count()).toBe(1);
    expect(await database.prisma.outbox.count()).toBe(1);
  });

  it('rolls the row back with the user when the transaction fails', async () => {
    const roleId = await database.findRoleId('CUSTOMER');

    await expect(
      database.unitOfWork.run(async (tx) => {
        await database.userRepository.create(buildUserInput(roleId), tx);
        await database.outboxRepository.insert(tx, buildRow());
        throw new Error('abort after both writes');
      }),
    ).rejects.toThrow('abort after both writes');

    expect(await database.prisma.user.count()).toBe(0);
    expect(await database.prisma.outbox.count()).toBe(0);
  });

  it('writes no user when the outbox insert fails', async () => {
    const roleId = await database.findRoleId('CUSTOMER');
    const row = buildRow();
    await database.unitOfWork.run((tx) => database.outboxRepository.insert(tx, row));

    await expect(
      database.unitOfWork.run(async (tx) => {
        await database.userRepository.create(buildUserInput(roleId), tx);
        await database.outboxRepository.insert(tx, row);
      }),
    ).rejects.toThrow();

    expect(await database.prisma.user.count()).toBe(0);
    expect(await database.prisma.outbox.count()).toBe(1);
  });

  it('refuses a handle that did not come from the unit of work, and writes nothing', async () => {
    const notFromUnitOfWork: Transaction = { isTransaction: true };

    await expect(
      database.outboxRepository.insert(notFromUnitOfWork, buildRow()),
    ).rejects.toBeInstanceOf(TypeError);

    expect(await database.prisma.outbox.count()).toBe(0);
  });

  it('refuses a second event for the same aggregate and version', async () => {
    const aggregateId = randomUUID();
    await database.unitOfWork.run((tx) =>
      database.outboxRepository.insert(tx, buildRow({ aggregateId })),
    );

    await expect(
      database.unitOfWork.run((tx) =>
        database.outboxRepository.insert(tx, buildRow({ aggregateId })),
      ),
    ).rejects.toThrow();
  });
});
