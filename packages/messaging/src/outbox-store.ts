import { type OutboxRow } from './outbox-row';

/**
 * Where outbox rows are kept. Each service implements it over its own database; `TTransaction` is
 * that service's opaque transaction type, so a row can only be inserted inside a transaction.
 */
export interface OutboxStore<TTransaction> {
  /**
   * Inserts one unpublished row in the caller's transaction.
   *
   * @param transaction - The transaction that also holds the state change the event describes.
   * @param row - The row to insert.
   */
  insert: (transaction: TTransaction, row: OutboxRow) => Promise<void>;
}
