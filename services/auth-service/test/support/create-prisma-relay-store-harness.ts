import {
  type ContractRow,
  type OutboxRelayStoreHarness,
  type RelayRowView,
} from '@ticketnest/messaging/testing';

import { type TestDatabase } from './test-database';

/** Row `n` is created `n` seconds after this instant, so claim order never hangs on a timestamp tie. */
const FIRST_CREATED_AT_MS = Date.parse('2026-01-01T00:00:00.000Z');
const SECOND_MS = 1000;

interface StoredRelayRow {
  readonly attempts: number;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly locked_by: string | null;
  readonly locked_until: Date | null;
}

/**
 * Connects the shared relay store contract to the real repository and the test Postgres. Rows are
 * written with plain SQL, because the contract needs to choose `created_at` and `attempts`, which
 * the outbox repository does not let a caller set. The clock is moved by shifting the lease
 * deadlines back, which is what time passing looks like to a row.
 *
 * @param database - The test database, already emptied for this test.
 * @returns The harness the contract runs against `database.outboxRelayRepository`.
 */
export function createPrismaRelayStoreHarness(database: TestDatabase): OutboxRelayStoreHarness {
  let addedRowCount = 0;

  return {
    store: database.outboxRelayRepository,
    /**
     * Inserts one unpublished row whose `created_at` follows the order the rows were added in.
     *
     * @param row - The row to insert.
     */
    async addRow(row: ContractRow) {
      addedRowCount += 1;
      const createdAt = new Date(FIRST_CREATED_AT_MS + addedRowCount * SECOND_MS);
      const [aggregateType = row.type] = row.type.split('.');
      await database.pool.query(
        `INSERT INTO outbox
           (id, aggregate_type, aggregate_id, aggregate_version, type, payload, created_at, attempts)
         VALUES ($1::uuid, $2, $3, 1, $4, $5::jsonb, $6, $7)`,
        [
          row.id,
          aggregateType,
          row.id,
          row.type,
          JSON.stringify(row.payload),
          createdAt,
          row.attempts,
        ],
      );
    },
    /**
     * Lets time pass for every lease and retry delay by shifting their deadlines back.
     *
     * @param durationMs - How far to move the clock, in milliseconds.
     */
    async advanceTime(durationMs: number) {
      await database.pool.query(
        `UPDATE outbox
         SET locked_until = locked_until - ($1::double precision * interval '1 millisecond')
         WHERE locked_until IS NOT NULL`,
        [durationMs],
      );
    },
    /**
     * @param id - An event id that was added.
     * @returns The row as the table holds it now.
     * @throws Error when no such row exists, which is a mistake in the test.
     */
    async readRow(id: string): Promise<RelayRowView> {
      const { rows } = await database.pool.query<StoredRelayRow>(
        `SELECT attempts, published_at, failed_at, locked_by, locked_until
         FROM outbox WHERE id = $1`,
        [id],
      );
      const [row] = rows;
      if (row === undefined) {
        throw new Error(`No outbox row ${id} in the test database.`);
      }
      return {
        attempts: row.attempts,
        isPublished: row.published_at !== null,
        isFailed: row.failed_at !== null,
        lockedBy: row.locked_by ?? undefined,
        isLocked: row.locked_until !== null,
      };
    },
  };
}
