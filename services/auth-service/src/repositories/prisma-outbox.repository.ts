import { type OutboxRow, type OutboxStore } from '@ticketnest/messaging';

import { type Prisma } from '../generated/prisma/client';

import { PrismaTransaction } from './prisma-transaction';
import { type Transaction } from './transaction';

/**
 * `OutboxStore` backed by Prisma: the only code that inserts into the `outbox` table. The relay's
 * `PrismaOutboxRelayRepository` is the only code that updates its rows.
 *
 * It has no client of its own and never falls back to one. It writes through the client bound to
 * the transaction it is given, so an outbox row can never be committed apart from the state change
 * it describes.
 */
export class PrismaOutboxRepository implements OutboxStore<Transaction> {
  /**
   * Inserts one unpublished row in the caller's transaction.
   *
   * @param tx - The handle from `UnitOfWork.run`, the same one used for the state change.
   * @param row - The row built by the outbox writer.
   * @throws TypeError when `tx` was not created by `PrismaUnitOfWork`. Nothing is written.
   * @throws Error when the database rejects the row, for example a repeated event id or a repeated
   * aggregate version. The caller's transaction then rolls back.
   */
  async insert(tx: Transaction, row: OutboxRow): Promise<void> {
    if (!(tx instanceof PrismaTransaction)) {
      throw new TypeError('Transaction handle was not created by PrismaUnitOfWork.');
    }
    await tx.client.outbox.create({
      data: {
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        aggregateVersion: row.aggregateVersion,
        type: row.type,
        // The payload is a parsed event envelope, so it is plain JSON.
        payload: row.payload as Prisma.InputJsonObject,
      },
    });
  }
}
