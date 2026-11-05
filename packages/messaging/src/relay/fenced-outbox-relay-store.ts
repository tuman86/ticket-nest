import { type ClaimedOutboxRow, type OutboxRelayStore } from '../outbox-relay-store';

/**
 * An outbox relay store that can be closed for good. Once fenced, every call is a no-op that does
 * not reach the database, so a publish that confirms late, after the relay stopped waiting and the
 * pool is closing, cannot touch it (ADR-0007, shutdown).
 */
export class FencedOutboxRelayStore implements OutboxRelayStore {
  private hasBeenFenced = false;

  /**
   * @param inner - The real store.
   */
  constructor(private readonly inner: OutboxRelayStore) {}

  /** Whether `fence` has been called, so every call is now a no-op. */
  get isFenced(): boolean {
    return this.hasBeenFenced;
  }

  /** Turns every later call into a no-op. Safe to call more than once. */
  fence(): void {
    this.hasBeenFenced = true;
  }

  /**
   * @param claimId - A fresh id for this claim.
   * @param limit - The most rows to claim.
   * @param leaseMs - How long the claim keeps the rows.
   * @returns The claimed rows, or none once fenced.
   */
  claimBatch(
    claimId: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly ClaimedOutboxRow[]> {
    return this.hasBeenFenced
      ? Promise.resolve([])
      : this.inner.claimBatch(claimId, limit, leaseMs);
  }

  /**
   * @param claimId - The claim that took the rows.
   * @param ids - The event ids to mark.
   * @returns How many rows were marked, 0 once fenced.
   */
  markPublished(claimId: string, ids: readonly string[]): Promise<number> {
    return this.hasBeenFenced ? Promise.resolve(0) : this.inner.markPublished(claimId, ids);
  }

  /**
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @param retryAfterMs - The backoff, in milliseconds.
   * @returns 1 when the row was updated, 0 when not or once fenced.
   */
  recordFailure(claimId: string, id: string, retryAfterMs: number): Promise<number> {
    return this.hasBeenFenced
      ? Promise.resolve(0)
      : this.inner.recordFailure(claimId, id, retryAfterMs);
  }

  /**
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @returns 1 when the row was updated, 0 when not or once fenced.
   */
  markFailed(claimId: string, id: string): Promise<number> {
    return this.hasBeenFenced ? Promise.resolve(0) : this.inner.markFailed(claimId, id);
  }
}
