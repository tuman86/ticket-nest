import { type OutboxRow } from '../../src/outbox-row';
import { type OutboxStore } from '../../src/outbox-store';

/**
 * An outbox that keeps rows in memory. It ignores the transaction it is given, so it cannot show
 * a rollback: tests that need one use the service's own fake unit of work around it.
 */
export class InMemoryOutboxStore<TTransaction = unknown> implements OutboxStore<TTransaction> {
  /** Every row inserted, in order. */
  readonly rows: OutboxRow[] = [];

  /** The transaction each row arrived with, so a test can check it was the caller's. */
  readonly transactions: TTransaction[] = [];

  /**
   * @param transaction - Recorded, otherwise unused.
   * @param row - Stored as is.
   */
  insert(transaction: TTransaction, row: OutboxRow): Promise<void> {
    this.transactions.push(transaction);
    this.rows.push(row);
    return Promise.resolve();
  }
}
