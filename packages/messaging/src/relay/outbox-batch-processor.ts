import { type EventEnvelope } from '@ticketnest/contracts';
import { generateCorrelationId, type Logger, runWithCorrelationId } from '@ticketnest/logger';

import { BrokerUnavailableError } from '../broker-unavailable.error';
import { type EventPublisher } from '../event-publisher';
import { type IdGenerator } from '../id-generator';
import { type ClaimedOutboxRow, type OutboxRelayStore } from '../outbox-relay-store';
import { PublishNotConfirmedError } from '../publish-not-confirmed.error';

import { calculateBackoffMs } from './calculate-backoff';
import { parseStoredEvent } from './parse-stored-event';
import { type RandomSource } from './random-source';
import { CLAIM_LEASE_MS, MAX_ATTEMPTS, PUBLISH_CONFIRM_TIMEOUT_MS } from './relay-constants';
import { type Sleep } from './sleep';

/** What one batch told the loop. */
export interface BatchResult {
  /** How many rows the claim returned. A full batch means more may be waiting. */
  readonly claimedCount: number;
  /** Whether a publish found the broker unreachable, so the loop must back off. */
  readonly isConnectionLost: boolean;
}

export interface OutboxBatchProcessorDependencies {
  readonly store: OutboxRelayStore;
  readonly publisher: EventPublisher;
  readonly idGenerator: IdGenerator;
  readonly randomSource: RandomSource;
  /** Times the publish deadline. */
  readonly sleep: Sleep;
  readonly logger: Logger;
  /** The most rows one batch claims, and so the most publishes in flight. */
  readonly batchSize: number;
  /**
   * Whether the store has been fenced off. After that a store update does nothing by design, so a
   * smaller count is not a lost claim and must not be reported as one.
   */
  readonly isStoreFenced: () => boolean;
}

/**
 * What became of one row. Only `published` rows are marked together at the end of the batch, and
 * only `store-failed` makes the batch throw.
 */
type RowOutcome =
  | { readonly kind: 'published'; readonly id: string }
  | { readonly kind: 'handled' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'store-failed'; readonly error: unknown };

/**
 * One tick of the relay: claim a batch, publish every row at once, then mark the outcome
 * (ADR-0007). It never opens a transaction and never throws for a row the broker refused or for an
 * unexpected error of the publisher; it rethrows only an error of the store itself, after it has
 * marked what was confirmed.
 */
export class OutboxBatchProcessor {
  /**
   * @param dependencies - The store, publisher, id source, random source, sleep, logger, batch size
   * and fence check.
   */
  constructor(private readonly dependencies: OutboxBatchProcessorDependencies) {}

  /**
   * Claims one batch and publishes it. Lines logged for the batch carry a correlation id of their
   * own, and lines logged for one row carry the correlation id of its event.
   *
   * @returns How many rows were claimed and whether the broker was found unreachable.
   * @throws Error whatever the store threw, after every confirmed row has been marked.
   */
  run(): Promise<BatchResult> {
    return runWithCorrelationId(generateCorrelationId(), () => this.processBatch());
  }

  /**
   * @returns The batch result.
   * @throws Error the first error of the store, once the confirmed rows are marked.
   */
  private async processBatch(): Promise<BatchResult> {
    const { store, idGenerator, batchSize } = this.dependencies;
    const claimId = idGenerator.generate();
    const rows = await store.claimBatch(claimId, batchSize, CLAIM_LEASE_MS);
    const outcomes = await Promise.all(rows.map((row) => this.handleRow(claimId, row)));
    await this.markPublishedRows(claimId, outcomes);
    const storeFailure = outcomes.find((outcome) => outcome.kind === 'store-failed');
    if (storeFailure !== undefined) {
      throw storeFailure.error;
    }
    return {
      claimedCount: rows.length,
      isConnectionLost: outcomes.some((outcome) => outcome.kind === 'unavailable'),
    };
  }

  /**
   * Publishes one row, or gives up on it when its payload is not an event. Never rejects: whatever
   * goes wrong becomes an outcome, so one row cannot stop the others from being marked.
   *
   * @param claimId - The claim that took the row.
   * @param row - The claimed row.
   * @returns What became of the row.
   */
  private async handleRow(claimId: string, row: ClaimedOutboxRow): Promise<RowOutcome> {
    try {
      const parsed = parseStoredEvent(row.payload);
      if (!parsed.isValid) {
        await this.giveUpOnInvalidPayload(claimId, row, parsed.failedFields);
        return { kind: 'handled' };
      }
      return await runWithCorrelationId(parsed.event.correlationId, () =>
        this.publishEvent(claimId, row, parsed.event),
      );
    } catch (error) {
      return { kind: 'store-failed', error };
    }
  }

  /**
   * @param claimId - The claim that took the row.
   * @param row - The claimed row.
   * @param event - The row's payload, checked.
   * @returns `published` when the broker confirmed, otherwise what the failure came to.
   * @throws Error an error of the store while recording a failure.
   */
  private async publishEvent(
    claimId: string,
    row: ClaimedOutboxRow,
    event: EventEnvelope,
  ): Promise<RowOutcome> {
    try {
      await this.publishWithDeadline(event);
      return { kind: 'published', id: row.id };
    } catch (error) {
      if (error instanceof BrokerUnavailableError) {
        return { kind: 'unavailable' };
      }
      if (error instanceof PublishNotConfirmedError) {
        await this.recordRowFailure(claimId, row, error);
      } else {
        this.logUnexpectedPublishError(row, error);
      }
      return { kind: 'handled' };
    }
  }

  /**
   * Publishes one event and gives up waiting after `PUBLISH_CONFIRM_TIMEOUT_MS`, so a publisher
   * that never answers cannot stall the batch. The publisher enforces the same limit itself; this
   * is the relay's own guarantee that it keeps ticking. An abandoned publish is left to finish or
   * fail on its own and its late result is ignored.
   *
   * @param event - The event to publish.
   * @throws PublishNotConfirmedError with reason `confirm_timeout` when the deadline passes first.
   * @throws Error whatever the publisher rejected with when it answered in time.
   */
  private async publishWithDeadline(event: EventEnvelope): Promise<void> {
    const deadline = new AbortController();
    const deadlinePassed = this.dependencies
      .sleep(PUBLISH_CONFIRM_TIMEOUT_MS, deadline.signal)
      .then(() => {
        if (!deadline.signal.aborted) {
          throw new PublishNotConfirmedError('confirm_timeout');
        }
      });
    try {
      await Promise.race([this.dependencies.publisher.publish(event), deadlinePassed]);
    } finally {
      deadline.abort();
    }
  }

  /**
   * Charges a failed attempt to a row: a retry with a backoff, or the end of the row when this was
   * its last attempt. Logs the id, type, attempt count and reason, never the payload.
   *
   * @param claimId - The claim that took the row.
   * @param row - The claimed row.
   * @param error - Why the broker did not confirm.
   */
  private async recordRowFailure(
    claimId: string,
    row: ClaimedOutboxRow,
    error: PublishNotConfirmedError,
  ): Promise<void> {
    const { store, randomSource, logger } = this.dependencies;
    const failureCount = row.attempts + 1;
    const fields = {
      eventId: row.id,
      type: row.type,
      attempts: failureCount,
      reason: error.reason,
    };
    if (failureCount >= MAX_ATTEMPTS) {
      const updatedCount = await store.markFailed(claimId, row.id);
      this.warnIfClaimLost(updatedCount, 1, 'claim was lost before the failure was recorded');
      if (updatedCount > 0) {
        logger.error(fields, 'event gave up after its last attempt');
      }
      return;
    }
    const retryAfterMs = calculateBackoffMs(failureCount, randomSource);
    const updatedCount = await store.recordFailure(claimId, row.id, retryAfterMs);
    this.warnIfClaimLost(updatedCount, 1, 'claim was lost before the failure was recorded');
    if (updatedCount > 0) {
      logger.warn({ ...fields, retryAfterMs }, 'event publish failed, it will be retried');
    }
  }

  /**
   * Logs an error of the publisher that is neither a refusal nor a lost connection. The row is left
   * alone, so it is claimed again when its lease expires and logs again, which keeps it visible.
   * Only the error's name is logged: its message could carry event content.
   *
   * @param row - The claimed row.
   * @param error - What the publisher threw.
   */
  private logUnexpectedPublishError(row: ClaimedOutboxRow, error: unknown): void {
    this.dependencies.logger.error(
      {
        eventId: row.id,
        type: row.type,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'publish failed with an unexpected error, the row is left for its lease to expire',
    );
  }

  /**
   * Ends a row whose stored payload is not an event envelope: retrying cannot fix it.
   *
   * @param claimId - The claim that took the row.
   * @param row - The claimed row.
   * @param failedFields - The names of the fields that failed, never their values.
   */
  private async giveUpOnInvalidPayload(
    claimId: string,
    row: ClaimedOutboxRow,
    failedFields: readonly string[],
  ): Promise<void> {
    const updatedCount = await this.dependencies.store.markFailed(claimId, row.id);
    this.warnIfClaimLost(updatedCount, 1, 'claim was lost before the failure was recorded');
    if (updatedCount > 0) {
      this.dependencies.logger.error(
        { eventId: row.id, type: row.type, failedFields },
        'stored event is not a valid envelope, it will not be published',
      );
    }
  }

  /**
   * Marks the confirmed rows with one call. A smaller count means another claim took some of them
   * while this one waited for the broker, so those rows will be published again.
   *
   * @param claimId - The claim that took the rows.
   * @param outcomes - What became of each row.
   */
  private async markPublishedRows(claimId: string, outcomes: readonly RowOutcome[]): Promise<void> {
    const publishedIds = outcomes.flatMap((outcome) =>
      outcome.kind === 'published' ? [outcome.id] : [],
    );
    if (publishedIds.length === 0) {
      return;
    }
    const markedCount = await this.dependencies.store.markPublished(claimId, publishedIds);
    this.warnIfClaimLost(
      markedCount,
      publishedIds.length,
      'claim was lost before the rows were marked',
    );
  }

  /**
   * Warns that another claim took rows away. Says nothing once the store is fenced, because then
   * every update returns zero by design and nothing was lost.
   *
   * @param updatedCount - How many rows a store update changed.
   * @param expectedCount - How many it was asked to change.
   * @param message - What to log when fewer were changed.
   */
  private warnIfClaimLost(updatedCount: number, expectedCount: number, message: string): void {
    if (updatedCount < expectedCount && !this.dependencies.isStoreFenced()) {
      this.dependencies.logger.warn({ expectedCount, updatedCount }, message);
    }
  }
}
