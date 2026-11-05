import { type ClaimedOutboxRow, type OutboxRelayStore } from '@ticketnest/messaging';
import { z } from 'zod';

import { type PrismaClient } from '../generated/prisma/client';

/** The columns `claimBatch` reads back. `created_at` and `aggregate_version` only fix the order. */
const claimedRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  attempts: z.number().int(),
  created_at: z.date(),
  aggregate_version: z.number().int(),
});

/**
 * `OutboxRelayStore` backed by Prisma: the only code that touches the relay's columns
 * (`locked_until`, `locked_by`, `failed_at`) and sets `published_at` (ADR-0007).
 *
 * Unlike the other repositories it takes no transaction handle. The relay publishes outside any
 * transaction, so every method is one self-contained statement on the shared client, and no
 * connection or row lock is held while the broker answers.
 *
 * Every time written here is the database clock (`now()`), so replicas never compare their own
 * clocks. Every update names the claim and matches `locked_by`, and then clears it, so a claim can
 * change a row only once.
 */
export class PrismaOutboxRelayRepository implements OutboxRelayStore {
  /**
   * @param client - The shared Prisma client, used outside any transaction.
   */
  constructor(private readonly client: PrismaClient) {}

  /**
   * Leases up to `limit` unpublished, unfailed, unleased rows to `claimId` in one statement. Rows
   * locked by a concurrent claim are skipped (`FOR UPDATE SKIP LOCKED`), so replicas never wait for
   * each other or take the same row.
   *
   * @param claimId - A fresh id for this claim.
   * @param limit - The most rows to claim, at least 1.
   * @param leaseMs - How long the claim keeps the rows, in milliseconds, added to the database clock.
   * @returns The claimed rows, oldest first (`created_at`, then `aggregate_version`).
   * @throws Error when the database rejects the statement, or ZodError when it returns a row of an
   * unexpected shape.
   */
  async claimBatch(
    claimId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedOutboxRow[]> {
    const rows: unknown = await this.client.$queryRaw`
      UPDATE outbox
      SET locked_until = now() + (${leaseMs}::double precision * interval '1 millisecond'),
          locked_by = ${claimId}
      WHERE id IN (
        SELECT id FROM outbox
        WHERE published_at IS NULL
          AND failed_at IS NULL
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY created_at, aggregate_version
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts, created_at, aggregate_version`;

    // `UPDATE ... RETURNING` does not promise an order, so restore the claim order here.
    return claimedRecordSchema
      .array()
      .parse(rows)
      .sort(
        (left, right) =>
          left.created_at.getTime() - right.created_at.getTime() ||
          left.aggregate_version - right.aggregate_version,
      )
      .map((record) => ({
        id: record.id,
        type: record.type,
        payload: record.payload,
        attempts: record.attempts,
      }));
  }

  /**
   * Marks the rows the claim still holds as published and releases the claim.
   *
   * @param claimId - The claim that took the rows.
   * @param ids - The event ids to mark.
   * @returns How many rows were marked. Fewer than `ids.length` means another claim took some.
   * @throws Error when the database rejects the statement.
   */
  async markPublished(claimId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    return this.client.$executeRaw`
      UPDATE outbox
      SET published_at = now(), locked_by = NULL, locked_until = NULL
      WHERE id = ANY(${[...ids]}::uuid[]) AND locked_by = ${claimId}`;
  }

  /**
   * Charges one failed attempt to a row the claim still holds, releases the claim and holds the row
   * back for `retryAfterMs`.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @param retryAfterMs - The backoff in milliseconds, added to the database clock.
   * @returns 1 when the row was updated, 0 when the claim no longer holds it.
   * @throws Error when the database rejects the statement.
   */
  async recordFailure(claimId: string, id: string, retryAfterMs: number): Promise<number> {
    return this.client.$executeRaw`
      UPDATE outbox
      SET attempts = attempts + 1,
          locked_by = NULL,
          locked_until = now() + (${retryAfterMs}::double precision * interval '1 millisecond')
      WHERE id = ${id}::uuid AND locked_by = ${claimId}`;
  }

  /**
   * Gives up on a row the claim still holds for good and releases the claim. A person re-queues it.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @returns 1 when the row was updated, 0 when the claim no longer holds it.
   * @throws Error when the database rejects the statement.
   */
  async markFailed(claimId: string, id: string): Promise<number> {
    return this.client.$executeRaw`
      UPDATE outbox
      SET failed_at = now(), locked_by = NULL, locked_until = NULL
      WHERE id = ${id}::uuid AND locked_by = ${claimId}`;
  }
}
