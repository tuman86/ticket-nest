import { type RandomSource } from './random-source';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_MIN_MS } from './relay-constants';

/**
 * Calculates how long to wait before the next try after a failure: exponential, with full jitter.
 * The upper bound starts at `BACKOFF_BASE_MS`, doubles with every failure and stops at
 * `BACKOFF_CAP_MS`; the result is a random point between `BACKOFF_MIN_MS` and that bound.
 *
 * @param failureCount - How many failures in a row there have been, counting this one (1 or more).
 * @param randomSource - Where the jitter comes from.
 * @returns The delay in whole milliseconds.
 */
export function calculateBackoffMs(failureCount: number, randomSource: RandomSource): number {
  const upperBoundMs = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failureCount - 1));
  return Math.floor(BACKOFF_MIN_MS + randomSource.next() * (upperBoundMs - BACKOFF_MIN_MS));
}
