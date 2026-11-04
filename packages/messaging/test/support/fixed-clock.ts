import { type Clock } from '../../src/clock';

/** A clock that always reads the same instant, so a test can assert exact timestamps. */
export class FixedClock implements Clock {
  /**
   * @param instant - The time every `now()` call returns.
   */
  constructor(private readonly instant: Date) {}

  /**
   * @returns A copy of the fixed instant, so a caller cannot move the clock by mutating it.
   */
  now(): Date {
    return new Date(this.instant);
  }
}
