/** One outbox row as the relay receives it from a claim. */
export interface ClaimedOutboxRow {
  /** The event id. */
  readonly id: string;
  /** The event type, also the routing key. */
  readonly type: string;
  /** The stored JSON. Typed `unknown` because the relay re-checks it before publishing. */
  readonly payload: unknown;
  /** How many failures this row has already had. */
  readonly attempts: number;
}

/**
 * Where the relay claims and marks outbox rows. Each service implements it over its own database
 * (ADR-0007), so `packages/messaging` never imports a Prisma client.
 *
 * Every update names the `claimId` of the claim that took the row and changes the row only while
 * that claim still holds it. A claim whose lease expired therefore changes nothing, and the update
 * reports it by returning fewer rows than it was asked to change.
 */
export interface OutboxRelayStore {
  /**
   * Claims up to `limit` unpublished rows that are not failed and not leased, oldest first, and
   * leases them to `claimId`. One statement, no transaction held afterwards.
   *
   * @param claimId - A fresh id for this claim.
   * @param limit - The most rows to claim.
   * @param leaseMs - How long the claim keeps the rows, in milliseconds. The database adds it to its
   * own clock.
   * @returns The claimed rows.
   */
  claimBatch: (
    claimId: string,
    limit: number,
    leaseMs: number,
  ) => Promise<readonly ClaimedOutboxRow[]>;

  /**
   * Marks rows as published after the broker confirmed them.
   *
   * @param claimId - The claim that took the rows.
   * @param ids - The event ids to mark.
   * @returns How many rows were marked. Fewer than `ids.length` means the claim was lost.
   */
  markPublished: (claimId: string, ids: readonly string[]) => Promise<number>;

  /**
   * Records one failed attempt: the row's attempt count goes up by one and it is not claimable
   * again until `retryAfterMs` has passed.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @param retryAfterMs - The backoff, in milliseconds, added to the database clock.
   * @returns 1 when the row was updated, 0 when the claim was lost.
   */
  recordFailure: (claimId: string, id: string, retryAfterMs: number) => Promise<number>;

  /**
   * Gives up on a row for good (`failed_at`). A person re-queues it by hand.
   *
   * @param claimId - The claim that took the row.
   * @param id - The event id.
   * @returns 1 when the row was updated, 0 when the claim was lost.
   */
  markFailed: (claimId: string, id: string) => Promise<number>;
}
