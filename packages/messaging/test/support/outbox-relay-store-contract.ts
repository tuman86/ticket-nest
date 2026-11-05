// The behaviour every `OutboxRelayStore` must have (ADR-0007). The in-memory fake runs it in this
// package and each service's Postgres repository runs it in its integration tests, so the fake the
// relay's unit tests rely on cannot drift from the real SQL. Relative imports on purpose, because
// `@/` would resolve to the importing workspace.
import { beforeEach, describe, expect, it } from 'vitest';

import { type ClaimedOutboxRow, type OutboxRelayStore } from '../../src/outbox-relay-store';

const LEASE_MS = 60_000;
const PAST_LEASE_MS = LEASE_MS + 1;
const RETRY_DELAY_MS = 5_000;
const PAST_RETRY_DELAY_MS = RETRY_DELAY_MS + 1;
const LONG_TIME_MS = 24 * 60 * 60 * 1000;
const LIMIT_ABOVE_ANY_TEST = 100;
const UUID_LAST_GROUP_LENGTH = 12;
const DEFAULT_EVENT_TYPE = 'user.registered';

const CLAIM_A = 'claim-a';
const CLAIM_B = 'claim-b';

/** One row a contract test asks the harness to insert as unpublished and unleased. */
export interface ContractRow {
  /** The event id. A UUID, because a real outbox table keys on one. */
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  /** Failures the row has already had. */
  readonly attempts: number;
}

/** What a contract test can see of a row, whichever store holds it. */
export interface RelayRowView {
  readonly attempts: number;
  readonly isPublished: boolean;
  readonly isFailed: boolean;
  /** The claim that holds the row, or `undefined` when none does. */
  readonly lockedBy: string | undefined;
  /** Whether the row has a lease deadline (a lease or a retry delay). */
  readonly isLocked: boolean;
}

/** What an implementation gives the contract so it can run against its own storage. */
export interface OutboxRelayStoreHarness {
  readonly store: OutboxRelayStore;
  /**
   * Inserts one unpublished, unleased row. Rows are older in the order they are added.
   *
   * @param row - The row to insert.
   */
  addRow: (row: ContractRow) => Promise<void>;
  /**
   * Moves the store's clock forward, which ends leases and retry delays that are due.
   *
   * @param durationMs - How far to move it, in milliseconds.
   */
  advanceTime: (durationMs: number) => Promise<void>;
  /**
   * @param id - An event id that was added.
   * @returns The row as the store holds it now.
   */
  readRow: (id: string) => Promise<RelayRowView>;
}

/**
 * @param sequence - A number from 1.
 * @returns A valid, predictable UUID for it.
 */
function buildRowId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(UUID_LAST_GROUP_LENGTH, '0')}`;
}

/**
 * Adds rows with ids 1 to `count`, oldest first.
 *
 * @param harness - The harness to add them to.
 * @param count - How many rows to add.
 * @returns The event ids, oldest first.
 */
async function addRows(harness: OutboxRelayStoreHarness, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const id = buildRowId(sequence);
    await harness.addRow({ id, type: DEFAULT_EVENT_TYPE, payload: { marker: id }, attempts: 0 });
    ids.push(id);
  }
  return ids;
}

/**
 * @param harness - The harness holding the row.
 * @returns The id of the one row that was added.
 */
async function addOneRow(harness: OutboxRelayStoreHarness): Promise<string> {
  const [id] = await addRows(harness, 1);
  if (id === undefined) {
    throw new Error('addRows returned no row.');
  }
  return id;
}

/**
 * @param rows - Claimed rows.
 * @returns Their event ids, in the order they were returned.
 */
function listIds(rows: readonly ClaimedOutboxRow[]): string[] {
  return rows.map((row) => row.id);
}

/**
 * Registers the contract tests for `claimBatch`.
 *
 * @param getHarness - Returns the harness built for the current test.
 */
function describeClaimBatch(getHarness: () => OutboxRelayStoreHarness): void {
  describe('claimBatch', () => {
    it('returns the id, type, payload and attempts of a claimable row', async () => {
      const { store, addRow } = getHarness();
      const id = buildRowId(1);
      const payload = { id, data: { nested: [1, 'two', { three: true }] } };
      await addRow({ id, type: 'booking.created', payload, attempts: 3 });

      const claimed = await store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      expect(claimed).toEqual([{ id, type: 'booking.created', payload, attempts: 3 }]);
    });

    it('claims the oldest rows first', async () => {
      const harness = getHarness();
      const ids = await addRows(harness, 3);

      const claimed = await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      expect(listIds(claimed)).toEqual(ids);
    });

    it('claims no more rows than the limit', async () => {
      const harness = getHarness();
      const ids = await addRows(harness, 3);

      const claimed = await harness.store.claimBatch(CLAIM_A, 2, LEASE_MS);

      expect(listIds(claimed)).toEqual(ids.slice(0, 2));
    });

    it('returns nothing when no row is claimable', async () => {
      const { store } = getHarness();

      expect(await store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('does not claim a row that another claim holds', async () => {
      const { store, addRow } = getHarness();
      await addRow({ id: buildRowId(1), type: DEFAULT_EVENT_TYPE, payload: {}, attempts: 0 });
      await store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      expect(await store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('claims a row again once its lease has ended', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      await harness.advanceTime(PAST_LEASE_MS);
      const claimed = await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      expect(listIds(claimed)).toEqual([id]);
    });

    it('does not claim a published row', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.markPublished(CLAIM_A, [id]);

      await harness.advanceTime(LONG_TIME_MS);

      expect(await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('does not claim a failed row', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.markFailed(CLAIM_A, id);

      await harness.advanceTime(LONG_TIME_MS);

      expect(await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('does not claim a row during its retry delay', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      expect(await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('claims a row again once its retry delay has passed', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      await harness.advanceTime(PAST_RETRY_DELAY_MS);
      const claimed = await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      expect(claimed).toEqual([expect.objectContaining({ id, attempts: 1 })]);
    });
  });
}

/**
 * Registers the contract tests for `markPublished`.
 *
 * @param getHarness - Returns the harness built for the current test.
 */
function describeMarkPublished(getHarness: () => OutboxRelayStoreHarness): void {
  describe('markPublished', () => {
    it('marks the claimed rows as published and returns how many', async () => {
      const harness = getHarness();
      const ids = await addRows(harness, 2);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const markedCount = await harness.store.markPublished(CLAIM_A, ids);

      expect(markedCount).toBe(2);
      expect((await harness.readRow(buildRowId(1))).isPublished).toBe(true);
      expect((await harness.readRow(buildRowId(2))).isPublished).toBe(true);
    });

    it('clears the claim from the marked rows', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      await harness.store.markPublished(CLAIM_A, [id]);

      expect(await harness.readRow(id)).toMatchObject({ lockedBy: undefined, isLocked: false });
    });

    it('changes nothing and returns 0 for another claim id', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const markedCount = await harness.store.markPublished(CLAIM_B, [id]);

      expect(markedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ isPublished: false, lockedBy: CLAIM_A });
    });

    it('marks only the rows the claim still holds when some were taken', async () => {
      const harness = getHarness();
      const ids = await addRows(harness, 2);
      const takenId = buildRowId(1);
      const heldId = buildRowId(2);
      await harness.store.claimBatch(CLAIM_A, 2, LEASE_MS);
      await harness.advanceTime(PAST_LEASE_MS);
      await harness.store.claimBatch(CLAIM_B, 1, LEASE_MS);

      const markedCount = await harness.store.markPublished(CLAIM_A, ids);

      expect(markedCount).toBe(1);
      expect(await harness.readRow(takenId)).toMatchObject({
        isPublished: false,
        lockedBy: CLAIM_B,
      });
      expect((await harness.readRow(heldId)).isPublished).toBe(true);
    });

    it('still marks a row whose lease ended when no other claim took it', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.advanceTime(PAST_LEASE_MS);

      const markedCount = await harness.store.markPublished(CLAIM_A, [id]);

      expect(markedCount).toBe(1);
      expect((await harness.readRow(id)).isPublished).toBe(true);
    });

    it('changes nothing and returns 0 once another claim took the row after its lease ended', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.advanceTime(PAST_LEASE_MS);
      await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const markedCount = await harness.store.markPublished(CLAIM_A, [id]);

      expect(markedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ isPublished: false, lockedBy: CLAIM_B });
    });

    it('returns 0 when called twice for the same rows', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.markPublished(CLAIM_A, [id]);

      expect(await harness.store.markPublished(CLAIM_A, [id])).toBe(0);
    });

    it('returns 0 for an empty id list', async () => {
      const { store } = getHarness();

      expect(await store.markPublished(CLAIM_A, [])).toBe(0);
    });
  });
}

/**
 * Registers the contract tests for `recordFailure`.
 *
 * @param getHarness - Returns the harness built for the current test.
 */
function describeRecordFailure(getHarness: () => OutboxRelayStoreHarness): void {
  describe('recordFailure', () => {
    it('adds one attempt and releases the claim', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      expect(updatedCount).toBe(1);
      expect(await harness.readRow(id)).toMatchObject({
        attempts: 1,
        lockedBy: undefined,
        isPublished: false,
        isFailed: false,
      });
    });

    it('changes nothing and returns 0 for another claim id', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.recordFailure(CLAIM_B, id, RETRY_DELAY_MS);

      expect(updatedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ attempts: 0, lockedBy: CLAIM_A });
    });

    it('returns 0 on a second call, so an attempt is never counted twice', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      const updatedCount = await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      expect(updatedCount).toBe(0);
      expect((await harness.readRow(id)).attempts).toBe(1);
    });

    it('changes nothing and returns 0 once another claim took the row after its lease ended', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.advanceTime(PAST_LEASE_MS);
      await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.recordFailure(CLAIM_A, id, RETRY_DELAY_MS);

      expect(updatedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ attempts: 0, lockedBy: CLAIM_B });
    });
  });
}

/**
 * Registers the contract tests for `markFailed`.
 *
 * @param getHarness - Returns the harness built for the current test.
 */
function describeMarkFailed(getHarness: () => OutboxRelayStoreHarness): void {
  describe('markFailed', () => {
    it('marks the row failed, releases the claim and never offers it again', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.markFailed(CLAIM_A, id);
      await harness.advanceTime(LONG_TIME_MS);

      expect(updatedCount).toBe(1);
      expect(await harness.readRow(id)).toMatchObject({
        isFailed: true,
        lockedBy: undefined,
        isLocked: false,
      });
      expect(await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS)).toEqual([]);
    });

    it('changes nothing and returns 0 for another claim id', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.markFailed(CLAIM_B, id);

      expect(updatedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ isFailed: false, lockedBy: CLAIM_A });
    });

    it('returns 0 on a second call', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.store.markFailed(CLAIM_A, id);

      expect(await harness.store.markFailed(CLAIM_A, id)).toBe(0);
    });

    it('changes nothing and returns 0 once another claim took the row after its lease ended', async () => {
      const harness = getHarness();
      const id = await addOneRow(harness);
      await harness.store.claimBatch(CLAIM_A, LIMIT_ABOVE_ANY_TEST, LEASE_MS);
      await harness.advanceTime(PAST_LEASE_MS);
      await harness.store.claimBatch(CLAIM_B, LIMIT_ABOVE_ANY_TEST, LEASE_MS);

      const updatedCount = await harness.store.markFailed(CLAIM_A, id);

      expect(updatedCount).toBe(0);
      expect(await harness.readRow(id)).toMatchObject({ isFailed: false, lockedBy: CLAIM_B });
    });
  });
}

/**
 * Registers the contract every `OutboxRelayStore` must satisfy. Call it inside a `describe` named
 * after the implementation.
 *
 * @param createHarness - Builds a fresh, empty harness. It runs before every test, so it must also
 * clear whatever a previous test left in a shared database.
 */
export function describeOutboxRelayStoreContract(
  createHarness: () => OutboxRelayStoreHarness | Promise<OutboxRelayStoreHarness>,
): void {
  let harness: OutboxRelayStoreHarness | undefined;

  beforeEach(async () => {
    harness = await createHarness();
  });

  /**
   * @returns The harness of the running test.
   * @throws Error when called outside a test, which is a mistake in this file.
   */
  function getHarness(): OutboxRelayStoreHarness {
    if (harness === undefined) {
      throw new Error('The harness is only available inside a test.');
    }
    return harness;
  }

  describeClaimBatch(getHarness);
  describeMarkPublished(getHarness);
  describeRecordFailure(getHarness);
  describeMarkFailed(getHarness);
}
