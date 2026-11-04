import { type OutboxStore } from '@ticketnest/messaging';

import { type Transaction } from '@/repositories/transaction';

/** An outbox whose insert always fails, like a database that rejects the write mid-transaction. */
export class FailingOutboxStore implements OutboxStore<Transaction> {
  /**
   * @returns A promise that always rejects.
   * @throws Error always, whatever the row.
   */
  insert(): Promise<void> {
    return Promise.reject(new Error('outbox insert failed'));
  }
}
