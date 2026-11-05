import { describe, expect, it } from 'vitest';

import { calculateBackoffMs } from '@/relay/calculate-backoff';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_MIN_MS } from '@/relay/relay-constants';

import { FakeRandomSource } from '../support/fake-random-source';

const LOWEST_RANDOM = 0;
const HIGHEST_RANDOM = 1;
const MIDDLE_RANDOM = 0.5;

describe('calculateBackoffMs', () => {
  it('starts at the floor when the random source returns its lowest value', () => {
    expect(calculateBackoffMs(1, new FakeRandomSource(LOWEST_RANDOM))).toBe(BACKOFF_MIN_MS);
  });

  it('reaches the base delay after the first failure when the random source returns its highest value', () => {
    expect(calculateBackoffMs(1, new FakeRandomSource(HIGHEST_RANDOM))).toBe(BACKOFF_BASE_MS);
  });

  it('picks a point inside the window from the random source', () => {
    const middle = BACKOFF_MIN_MS + MIDDLE_RANDOM * (BACKOFF_BASE_MS - BACKOFF_MIN_MS);

    expect(calculateBackoffMs(1, new FakeRandomSource(MIDDLE_RANDOM))).toBe(middle);
  });

  it('doubles the upper bound with every failure', () => {
    const highest = new FakeRandomSource(HIGHEST_RANDOM);

    const bounds = [1, 2, 3, 4, 5].map((failureCount) => calculateBackoffMs(failureCount, highest));

    expect(bounds).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it('caps the delay at five minutes', () => {
    const highest = new FakeRandomSource(HIGHEST_RANDOM);

    expect(calculateBackoffMs(20, highest)).toBe(BACKOFF_CAP_MS);
    expect(calculateBackoffMs(5_000, highest)).toBe(BACKOFF_CAP_MS);
  });

  it('never goes below the floor, so a retry is never immediate', () => {
    const lowest = new FakeRandomSource(LOWEST_RANDOM);

    const delays = [1, 2, 10, 50].map((failureCount) => calculateBackoffMs(failureCount, lowest));

    expect(delays.every((delay) => delay === BACKOFF_MIN_MS)).toBe(true);
  });

  it('returns a whole number of milliseconds', () => {
    expect(Number.isInteger(calculateBackoffMs(3, new FakeRandomSource(0.333)))).toBe(true);
  });
});
