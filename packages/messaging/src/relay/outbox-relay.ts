import { type Logger } from '@ticketnest/logger';

import { BrokerUnavailableError } from '../broker-unavailable.error';
import { type EventPublisher } from '../event-publisher';
import { type IdGenerator } from '../id-generator';
import { type OutboxRelayStore } from '../outbox-relay-store';

import { calculateBackoffMs } from './calculate-backoff';
import { FencedOutboxRelayStore } from './fenced-outbox-relay-store';
import { OutboxBatchProcessor } from './outbox-batch-processor';
import { type RandomSource } from './random-source';
import { RELAY_STOP_WAIT_MS } from './relay-constants';
import { type Sleep } from './sleep';

export interface OutboxRelayDependencies {
  readonly store: OutboxRelayStore;
  readonly publisher: EventPublisher;
  readonly idGenerator: IdGenerator;
  readonly randomSource: RandomSource;
  readonly sleep: Sleep;
  readonly logger: Logger;
  /** The most rows one batch claims. */
  readonly batchSize: number;
  /** How long to wait after a batch that was not full, in milliseconds. */
  readonly pollIntervalMs: number;
}

/** Wait after a full batch: more rows may be waiting, so poll again at once. */
const NO_WAIT_MS = 0;

/**
 * Moves outbox rows to the broker, one batch at a time, until it is stopped (ADR-0007).
 *
 * The loop runs one tick at a time. Each tick connects first and claims nothing while the broker
 * cannot be reached; a failed tick backs off with a growing delay that restarts after a good one.
 * `stop` is a hard fence: after it returns, nothing the relay still has in flight reaches the store.
 */
export class OutboxRelay {
  private readonly abortController = new AbortController();
  private readonly fencedStore: FencedOutboxRelayStore;
  private readonly processor: OutboxBatchProcessor;
  private loopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private isBrokerLost = false;

  /**
   * @param dependencies - The store, publisher, id and random sources, sleep, logger and the batch
   * size and poll interval.
   */
  constructor(private readonly dependencies: OutboxRelayDependencies) {
    this.fencedStore = new FencedOutboxRelayStore(dependencies.store);
    this.processor = new OutboxBatchProcessor({
      store: this.fencedStore,
      publisher: dependencies.publisher,
      idGenerator: dependencies.idGenerator,
      randomSource: dependencies.randomSource,
      sleep: dependencies.sleep,
      logger: dependencies.logger,
      batchSize: dependencies.batchSize,
      isStoreFenced: () => this.fencedStore.isFenced,
    });
  }

  /**
   * Starts the loop in the background. Calling it again does nothing, and neither does calling it
   * after `stop`: a stopped relay cannot be restarted, build a new one.
   */
  start(): void {
    this.loopPromise ??= this.runLoop();
  }

  /**
   * Stops claiming, lets the batch in flight finish for up to `RELAY_STOP_WAIT_MS`, then fences the
   * store so a late confirm cannot touch it. A row left unconfirmed is published again once its
   * lease expires. Safe to call more than once.
   *
   * @returns Resolves once the relay will make no more store calls.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  /** Ticks until `stop` is called. It never rejects: a tick handles its own failures. */
  private async runLoop(): Promise<void> {
    while (!this.isStopping()) {
      const waitMs = await this.runTick();
      if (waitMs > NO_WAIT_MS && !this.isStopping()) {
        await this.dependencies.sleep(waitMs, this.abortController.signal);
      }
    }
  }

  /**
   * Read through a method on purpose: the value changes while a tick awaits, which TypeScript's
   * narrowing of `signal.aborted` inside the loop would not see.
   *
   * @returns Whether `stop` has been called.
   */
  private isStopping(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Connects, then processes one batch.
   *
   * @returns How long to wait before the next tick, in milliseconds.
   */
  private async runTick(): Promise<number> {
    try {
      await this.dependencies.publisher.connect();
    } catch (error) {
      return error instanceof BrokerUnavailableError
        ? this.backOffAfterBrokerLoss()
        : this.backOffAfterError(error);
    }
    try {
      const result = await this.processor.run();
      if (result.isConnectionLost) {
        return this.backOffAfterBrokerLoss();
      }
      this.recordGoodTick();
      return result.claimedCount >= this.dependencies.batchSize
        ? NO_WAIT_MS
        : this.dependencies.pollIntervalMs;
    } catch (error) {
      return this.backOffAfterError(error);
    }
  }

  /**
   * Counts a tick that found the broker unreachable. Logged once, when the broker is first lost,
   * and without the driver's error: its message can carry the broker URL.
   *
   * @returns The backoff before the next tick, in milliseconds.
   */
  private backOffAfterBrokerLoss(): number {
    if (!this.isBrokerLost) {
      this.isBrokerLost = true;
      this.dependencies.logger.warn('broker connection lost, backing off');
    }
    return this.nextBackoffMs();
  }

  /**
   * Counts a tick that failed for any other reason, and logs it every time.
   *
   * @param error - What went wrong.
   * @returns The backoff before the next tick, in milliseconds.
   */
  private backOffAfterError(error: unknown): number {
    this.dependencies.logger.error({ err: error }, 'relay tick failed, backing off');
    return this.nextBackoffMs();
  }

  /**
   * @returns The backoff after one more failure in a row, in milliseconds.
   */
  private nextBackoffMs(): number {
    this.consecutiveFailures += 1;
    return calculateBackoffMs(this.consecutiveFailures, this.dependencies.randomSource);
  }

  /** Restarts the backoff and logs when the broker is back. */
  private recordGoodTick(): void {
    this.consecutiveFailures = 0;
    if (this.isBrokerLost) {
      this.isBrokerLost = false;
      this.dependencies.logger.info('broker connection restored');
    }
  }

  /** Ends the loop, waits for the batch in flight, then fences the store. */
  private async performStop(): Promise<void> {
    this.abortController.abort();
    if (this.loopPromise !== undefined && !(await this.waitForLoopToEnd(this.loopPromise))) {
      this.dependencies.logger.warn('relay stopped while a batch was still in flight');
    }
    this.fencedStore.fence();
  }

  /**
   * @param loop - The running loop.
   * @returns `true` when the loop ended in time, `false` when the stop wait ran out first.
   */
  private async waitForLoopToEnd(loop: Promise<void>): Promise<boolean> {
    const waitController = new AbortController();
    const hasEnded = await Promise.race([
      loop.then(() => true),
      this.dependencies.sleep(RELAY_STOP_WAIT_MS, waitController.signal).then(() => false),
    ]);
    waitController.abort();
    return hasEnded;
  }
}
