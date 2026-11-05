import { describe } from 'vitest';

import { InMemoryOutboxRelayStore } from './support/in-memory-outbox-relay-store';
import {
  describeOutboxRelayStoreContract,
  type OutboxRelayStoreHarness,
} from './support/outbox-relay-store-contract';

/**
 * @returns A harness over a new, empty in-memory store.
 */
function createInMemoryHarness(): OutboxRelayStoreHarness {
  const store = new InMemoryOutboxRelayStore();
  return {
    store,
    /**
     * @param row - The row to add as unpublished and unleased.
     */
    addRow(row) {
      store.add(row);
      return Promise.resolve();
    },
    /**
     * @param durationMs - How far to move the fake database clock, in milliseconds.
     */
    advanceTime(durationMs) {
      store.advanceTime(durationMs);
      return Promise.resolve();
    },
    /**
     * @param id - An event id that was added.
     * @returns The row as the in-memory store holds it now.
     * @throws Error when no such row exists, which is a mistake in the test.
     */
    readRow(id) {
      const row = store.findRowById(id);
      return Promise.resolve({
        attempts: row.attempts,
        isPublished: row.isPublished,
        isFailed: row.isFailed,
        lockedBy: row.lockedBy,
        isLocked: row.lockedUntilMs !== undefined,
      });
    },
  };
}

describe('InMemoryOutboxRelayStore', () => {
  describeOutboxRelayStoreContract(createInMemoryHarness);
});
