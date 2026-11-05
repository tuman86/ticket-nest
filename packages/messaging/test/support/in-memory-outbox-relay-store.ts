import { type ClaimedOutboxRow, type OutboxRelayStore } from '../../src/outbox-relay-store';

/** One row of the in-memory outbox, with the relay's columns. */
export interface InMemoryRelayRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  attempts: number;
  isPublished: boolean;
  isFailed: boolean;
  lockedBy: string | undefined;
  /** The fake database clock reading, in milliseconds, until which the row is not claimable. */
  lockedUntilMs: number | undefined;
}

/** One call the relay made to the store, recorded in order. */
export interface RelayStoreCall {
  readonly method: 'claimBatch' | 'markPublished' | 'recordFailure' | 'markFailed';
  readonly claimId: string;
  /** The event ids the call named. Empty for `claimBatch`. */
  readonly ids: readonly string[];
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly retryAfterMs?: number;
}

/** What a test gives to `add`. */
export interface RelayRowInput {
  readonly id: string;
  readonly payload: unknown;
  readonly type?: string;
  readonly attempts?: number;
}

const DEFAULT_EVENT_TYPE = 'user.registered';

/**
 * An outbox relay store that keeps rows in memory and behaves like the real one: a claim leases
 * rows, a lease ends when the fake database clock passes it, and every update is guarded by the
 * claim id and returns how many rows it changed.
 */
export class InMemoryOutboxRelayStore implements OutboxRelayStore {
  /** Every row, in insertion order, which is also claim order. */
  readonly rows: InMemoryRelayRow[] = [];

  /** Every call the relay made, in order. */
  readonly calls: RelayStoreCall[] = [];

  private nowMs = 0;

  /**
   * @param input - The row to add as unpublished and unleased.
   */
  add(input: RelayRowInput): void {
    this.rows.push({
      id: input.id,
      type: input.type ?? DEFAULT_EVENT_TYPE,
      payload: input.payload,
      attempts: input.attempts ?? 0,
      isPublished: false,
      isFailed: false,
      lockedBy: undefined,
      lockedUntilMs: undefined,
    });
  }

  /**
   * Moves the fake database clock forward, which ends leases.
   *
   * @param durationMs - How far to move it, in milliseconds.
   */
  advanceTime(durationMs: number): void {
    this.nowMs += durationMs;
  }

  /**
   * @param id - An event id.
   * @returns The row with that id.
   * @throws Error when no such row exists, which is a mistake in the test.
   */
  findRowById(id: string): InMemoryRelayRow {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new Error(`No row ${id} in the in-memory store.`);
    }
    return row;
  }

  /**
   * Leases the oldest claimable rows to the claim.
   *
   * @param claimId - The claim that takes the rows.
   * @param limit - The most rows to take.
   * @param leaseMs - How long the claim keeps them, on the fake database clock.
   * @returns The claimed rows.
   */
  claimBatch(
    claimId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedOutboxRow[]> {
    this.calls.push({ method: 'claimBatch', claimId, ids: [], limit, leaseMs });
    const claimed = this.rows
      .filter((row) => this.isClaimable(row))
      .slice(0, limit)
      .map((row) => {
        row.lockedBy = claimId;
        row.lockedUntilMs = this.nowMs + leaseMs;
        return { id: row.id, type: row.type, payload: row.payload, attempts: row.attempts };
      });
    return Promise.resolve(claimed);
  }

  /**
   * Marks the rows the claim still holds as published.
   *
   * @param claimId - The claim that took the rows.
   * @param ids - The event ids to mark.
   * @returns How many rows were marked.
   */
  markPublished(claimId: string, ids: readonly string[]): Promise<number> {
    this.calls.push({ method: 'markPublished', claimId, ids });
    const marked = ids.filter((id) =>
      this.updateOwnedRow(claimId, id, (row) => {
        row.isPublished = true;
      }),
    );
    return Promise.resolve(marked.length);
  }

  /**
   * Charges one failed attempt to a row the claim still holds and delays its next claim.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @param retryAfterMs - The backoff, on the fake database clock.
   * @returns 1 when the row was updated, 0 when the claim no longer holds it.
   */
  recordFailure(claimId: string, id: string, retryAfterMs: number): Promise<number> {
    this.calls.push({ method: 'recordFailure', claimId, ids: [id], retryAfterMs });
    const isUpdated = this.updateOwnedRow(claimId, id, (row) => {
      row.attempts += 1;
      row.lockedBy = undefined;
      row.lockedUntilMs = this.nowMs + retryAfterMs;
    });
    return Promise.resolve(isUpdated ? 1 : 0);
  }

  /**
   * Ends a row the claim still holds for good.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @returns 1 when the row was updated, 0 when the claim no longer holds it.
   */
  markFailed(claimId: string, id: string): Promise<number> {
    this.calls.push({ method: 'markFailed', claimId, ids: [id] });
    const isUpdated = this.updateOwnedRow(claimId, id, (row) => {
      row.isFailed = true;
    });
    return Promise.resolve(isUpdated ? 1 : 0);
  }

  /**
   * @param row - A row.
   * @returns Whether a claim may take it now.
   */
  private isClaimable(row: InMemoryRelayRow): boolean {
    const isLeased = row.lockedUntilMs !== undefined && row.lockedUntilMs >= this.nowMs;
    return !row.isPublished && !row.isFailed && !isLeased;
  }

  /**
   * Applies a change only when the claim still holds the row.
   *
   * @param claimId - The claim that wants to change the row.
   * @param id - The row's event id.
   * @param change - The change to apply.
   * @returns Whether the row was changed.
   */
  private updateOwnedRow(
    claimId: string,
    id: string,
    change: (row: InMemoryRelayRow) => void,
  ): boolean {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row?.lockedBy !== claimId || row.lockedUntilMs === undefined) {
      return false;
    }
    if (row.lockedUntilMs < this.nowMs) {
      return false;
    }
    change(row);
    return true;
  }
}
