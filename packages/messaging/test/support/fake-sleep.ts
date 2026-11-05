import { type Sleep } from '../../src/relay/sleep';

interface PendingSleep {
  readonly durationMs: number;
  readonly end: () => void;
}

/**
 * A sleep that never waits by itself. The test sees every duration that was asked for and decides
 * when each sleep ends, so the relay loop can be driven one step at a time without real timers.
 * An abort ends a sleep early, like the real one.
 */
export class FakeSleep {
  /** Every duration asked for, in call order, including sleeps that already ended. */
  readonly durations: number[] = [];

  private readonly pending: PendingSleep[] = [];

  /** The function to inject where the relay takes a `Sleep`. */
  readonly sleep: Sleep = (durationMs, signal) => {
    this.durations.push(durationMs);
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const pendingSleep: PendingSleep = {
        durationMs,
        end: () => {
          signal.removeEventListener('abort', pendingSleep.end);
          this.pending.splice(this.pending.indexOf(pendingSleep), 1);
          resolve();
        },
      };
      this.pending.push(pendingSleep);
      signal.addEventListener('abort', pendingSleep.end, { once: true });
    });
  };

  /** How many sleeps have not ended yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * @param excludedMs - A duration to leave out, such as the publish deadline every row asks for.
   * @returns Every duration asked for except that one, in call order.
   */
  durationsExcluding(excludedMs: number): number[] {
    return this.durations.filter((durationMs) => durationMs !== excludedMs);
  }

  /** Ends the oldest sleep that has not ended, as if its time had passed. */
  endOldest(): void {
    this.pending[0]?.end();
  }

  /**
   * Ends the oldest pending sleep that was asked for exactly this duration, as if its time had
   * passed. Used when several kinds of sleep are pending at once.
   *
   * @param durationMs - The duration of the sleep to end.
   */
  endSleepOf(durationMs: number): void {
    this.pending.find((candidate) => candidate.durationMs === durationMs)?.end();
  }
}
