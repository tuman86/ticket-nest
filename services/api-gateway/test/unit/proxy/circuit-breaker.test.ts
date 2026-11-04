import { ServiceUnavailableError } from '@ticketnest/errors';
import { describe, expect, it } from 'vitest';

import { CircuitBreaker } from '@/proxy/circuit-breaker';

const THRESHOLD = 3;
const OPEN_MS = 10_000;

/**
 * @returns A breaker on a clock the test moves, and a way to move it.
 */
function createBreaker(): { breaker: CircuitBreaker; advance: (milliseconds: number) => void } {
  let nowMs = 1_000_000;
  const breaker = new CircuitBreaker({
    failureThreshold: THRESHOLD,
    openMs: OPEN_MS,
    now: () => nowMs,
  });
  return {
    breaker,
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
  };
}

/**
 * @param breaker - The breaker to push to its threshold.
 */
function failUntilOpen(breaker: CircuitBreaker): void {
  for (let attempt = 0; attempt < THRESHOLD; attempt += 1) {
    breaker.beforeRequest();
    breaker.recordFailure();
  }
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const { breaker } = createBreaker();

    breaker.beforeRequest();
    breaker.recordFailure();
    breaker.beforeRequest();
    breaker.recordFailure();

    expect(() => {
      breaker.beforeRequest();
    }).not.toThrow();
  });

  it('counts failures in a row, so one success starts the count again', () => {
    const { breaker } = createBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(() => {
      breaker.beforeRequest();
    }).not.toThrow();
  });

  it('opens at the threshold and refuses with 503 and Retry-After', () => {
    const { breaker } = createBreaker();
    failUntilOpen(breaker);

    let error: unknown;
    try {
      breaker.beforeRequest();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ status: 503, headers: { 'Retry-After': '10' } });
  });

  it('tells the client how long is left, rounded up', () => {
    const { breaker, advance } = createBreaker();
    failUntilOpen(breaker);
    advance(OPEN_MS - 1_500);

    expect(() => {
      breaker.beforeRequest();
    }).toThrow(expect.objectContaining({ headers: { 'Retry-After': '2' } }) as Error);
  });

  it('lets exactly one trial request through once the open time has passed', () => {
    const { breaker, advance } = createBreaker();
    failUntilOpen(breaker);
    advance(OPEN_MS);

    expect(() => {
      breaker.beforeRequest();
    }).not.toThrow();
    expect(() => {
      breaker.beforeRequest();
    }).toThrow(ServiceUnavailableError);
  });

  it('closes after a successful trial', () => {
    const { breaker, advance } = createBreaker();
    failUntilOpen(breaker);
    advance(OPEN_MS);
    breaker.beforeRequest();
    breaker.recordSuccess();

    expect(() => {
      breaker.beforeRequest();
      breaker.beforeRequest();
    }).not.toThrow();
  });

  it('opens again at once when the trial fails, and waits the full time', () => {
    const { breaker, advance } = createBreaker();
    failUntilOpen(breaker);
    advance(OPEN_MS);
    breaker.beforeRequest();
    breaker.recordFailure();
    advance(OPEN_MS - 1);

    expect(() => {
      breaker.beforeRequest();
    }).toThrow(ServiceUnavailableError);
    advance(1);
    expect(() => {
      breaker.beforeRequest();
    }).not.toThrow();
  });

  it('releases a trial that ended for a reason unrelated to the service', () => {
    const { breaker, advance } = createBreaker();
    failUntilOpen(breaker);
    advance(OPEN_MS);
    breaker.beforeRequest();
    breaker.recordNeutral();

    expect(() => {
      breaker.beforeRequest();
    }).not.toThrow();
  });
});
