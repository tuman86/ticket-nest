import { randomUUID } from 'node:crypto';

import { describeOutboxRelayStoreContract } from '@ticketnest/messaging/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createPrismaRelayStoreHarness } from '../../support/create-prisma-relay-store-harness';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const CLAIM_A = 'claim-a';
const CLAIM_B = 'claim-b';
const LEASE_MS = 60_000;
const RETRY_DELAY_MS = 5_000;
const CONCURRENT_ROW_COUNT = 40;
const CONCURRENT_CLAIM_LIMIT = 25;
const LARGE_BATCH_SIZE = 500;
const NO_LIMIT = 1000;
const LOCK_HOLD_LIMIT_MS = 3_000;
/** `timestamptz(3)` rounds to the millisecond, and a JavaScript `Date` truncates to it. */
const ROUNDING_TOLERANCE_MS = 1;

let database: TestDatabase;

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.close();
});

/**
 * @returns The database's own current time, which is the clock the relay's leases use.
 */
async function readDatabaseTime(): Promise<Date> {
  const { rows } = await database.pool.query<{ now: Date }>('SELECT now() AS now');
  const [row] = rows;
  if (row === undefined) {
    throw new Error('SELECT now() returned no row.');
  }
  return row.now;
}

/** One fixed query per column, so no SQL is ever assembled from a variable. */
const TIMESTAMP_QUERIES = {
  locked_until: 'SELECT locked_until AS value FROM outbox WHERE id = $1',
  published_at: 'SELECT published_at AS value FROM outbox WHERE id = $1',
  failed_at: 'SELECT failed_at AS value FROM outbox WHERE id = $1',
} as const;

/**
 * @param column - A timestamp column of the `outbox` table.
 * @param id - The event id of the row.
 * @returns The column's value, which must be set.
 */
async function readTimestamp(column: keyof typeof TIMESTAMP_QUERIES, id: string): Promise<Date> {
  const { rows } = await database.pool.query<{ value: Date | null }>(TIMESTAMP_QUERIES[column], [
    id,
  ]);
  const [row] = rows;
  if (row?.value === null || row?.value === undefined) {
    throw new Error(`${column} of ${id} is not set.`);
  }
  return row.value;
}

/**
 * Inserts one unpublished `user.registered` row straight into the table.
 *
 * @param aggregateId - The aggregate the event belongs to.
 * @param aggregateVersion - The event's version of that aggregate.
 * @returns The new event id.
 */
async function insertRow(aggregateId: string, aggregateVersion: number): Promise<string> {
  const id = randomUUID();
  await database.pool.query(
    `INSERT INTO outbox (id, aggregate_type, aggregate_id, aggregate_version, type, payload, created_at)
     VALUES ($1, 'user', $2, $3, 'user.registered', '{}'::jsonb, '2026-01-01T00:00:00.000Z')`,
    [id, aggregateId, aggregateVersion],
  );
  return id;
}

/**
 * Asserts that a timestamp lies between two readings of the database clock, plus an offset.
 *
 * @param actual - The timestamp under test.
 * @param before - The database time read before the call.
 * @param after - The database time read after the call.
 * @param offsetMs - What the call adds to the database clock (the lease or retry delay), or 0.
 */
function expectBetweenDatabaseTimes(
  actual: Date,
  before: Date,
  after: Date,
  offsetMs: number,
): void {
  expect(actual.getTime()).toBeGreaterThanOrEqual(
    before.getTime() + offsetMs - ROUNDING_TOLERANCE_MS,
  );
  expect(actual.getTime()).toBeLessThanOrEqual(after.getTime() + offsetMs + ROUNDING_TOLERANCE_MS);
}

describe('PrismaOutboxRelayRepository', () => {
  describeOutboxRelayStoreContract(async () => {
    await database.resetTables();
    return createPrismaRelayStoreHarness(database);
  });

  describe('on Postgres', () => {
    beforeEach(async () => {
      await database.resetTables();
    });

    it('orders rows created at the same instant by aggregate version', async () => {
      const aggregateId = randomUUID();
      const third = await insertRow(aggregateId, 3);
      const first = await insertRow(aggregateId, 1);
      const second = await insertRow(aggregateId, 2);

      const claimed = await database.outboxRelayRepository.claimBatch(CLAIM_A, NO_LIMIT, LEASE_MS);

      expect(claimed.map((row) => row.id)).toEqual([first, second, third]);
    });

    it('skips a row locked by an open transaction instead of waiting for it', async () => {
      const lockedId = await insertRow(randomUUID(), 1);
      const freeId = await insertRow(randomUUID(), 1);
      const holder = await database.pool.connect();
      // Without SKIP LOCKED the claim would wait for this lock, so the timer ends the wait and the
      // assertion below fails instead of the test hanging.
      const safetyRelease = setTimeout(() => {
        void holder.query('ROLLBACK');
      }, LOCK_HOLD_LIMIT_MS);
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM outbox WHERE id = $1 FOR UPDATE', [lockedId]);

        const claimed = await database.outboxRelayRepository.claimBatch(
          CLAIM_A,
          NO_LIMIT,
          LEASE_MS,
        );

        expect(claimed.map((row) => row.id)).toEqual([freeId]);
      } finally {
        clearTimeout(safetyRelease);
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('gives two concurrent claims different rows and loses none', async () => {
      await Promise.all(
        Array.from({ length: CONCURRENT_ROW_COUNT }, () => insertRow(randomUUID(), 1)),
      );

      const [claimedByA, claimedByB] = await Promise.all([
        database.outboxRelayRepository.claimBatch(CLAIM_A, CONCURRENT_CLAIM_LIMIT, LEASE_MS),
        database.outboxRelayRepository.claimBatch(CLAIM_B, CONCURRENT_CLAIM_LIMIT, LEASE_MS),
      ]);

      const idsOfA = new Set(claimedByA.map((row) => row.id));
      const idsOfB = new Set(claimedByB.map((row) => row.id));
      expect([...idsOfA].filter((id) => idsOfB.has(id))).toEqual([]);
      expect(idsOfA.size + idsOfB.size).toBe(CONCURRENT_ROW_COUNT);
    });

    it('leases a row until the database clock plus the lease', async () => {
      const id = await insertRow(randomUUID(), 1);

      const before = await readDatabaseTime();
      await database.outboxRelayRepository.claimBatch(CLAIM_A, NO_LIMIT, LEASE_MS);
      const after = await readDatabaseTime();

      expectBetweenDatabaseTimes(await readTimestamp('locked_until', id), before, after, LEASE_MS);
    });

    it('holds a failed row back until the database clock plus the retry delay', async () => {
      const id = await insertRow(randomUUID(), 1);
      await database.outboxRelayRepository.claimBatch(CLAIM_A, NO_LIMIT, LEASE_MS);

      const before = await readDatabaseTime();
      await database.outboxRelayRepository.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);
      const after = await readDatabaseTime();

      expectBetweenDatabaseTimes(
        await readTimestamp('locked_until', id),
        before,
        after,
        RETRY_DELAY_MS,
      );
    });

    it('stamps published_at from the database clock', async () => {
      const id = await insertRow(randomUUID(), 1);
      await database.outboxRelayRepository.claimBatch(CLAIM_A, NO_LIMIT, LEASE_MS);

      const before = await readDatabaseTime();
      await database.outboxRelayRepository.markPublished(CLAIM_A, [id]);
      const after = await readDatabaseTime();

      expectBetweenDatabaseTimes(await readTimestamp('published_at', id), before, after, 0);
    });

    it('stamps failed_at from the database clock', async () => {
      const id = await insertRow(randomUUID(), 1);
      await database.outboxRelayRepository.claimBatch(CLAIM_A, NO_LIMIT, LEASE_MS);

      const before = await readDatabaseTime();
      await database.outboxRelayRepository.markFailed(CLAIM_A, id);
      const after = await readDatabaseTime();

      expectBetweenDatabaseTimes(await readTimestamp('failed_at', id), before, after, 0);
    });

    it('marks 500 ids in one call', async () => {
      await database.pool.query(
        `INSERT INTO outbox (id, aggregate_type, aggregate_id, aggregate_version, type, payload)
         SELECT gen_random_uuid(), 'user', gen_random_uuid()::text, 1, 'user.registered', '{}'::jsonb
         FROM generate_series(1, $1::int)`,
        [LARGE_BATCH_SIZE],
      );
      const claimed = await database.outboxRelayRepository.claimBatch(
        CLAIM_A,
        LARGE_BATCH_SIZE,
        LEASE_MS,
      );

      const markedCount = await database.outboxRelayRepository.markPublished(
        CLAIM_A,
        claimed.map((row) => row.id),
      );

      expect(markedCount).toBe(LARGE_BATCH_SIZE);
      expect(await database.prisma.outbox.count({ where: { publishedAt: { not: null } } })).toBe(
        LARGE_BATCH_SIZE,
      );
    });
  });
});
