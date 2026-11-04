/** Source of the current time. Injected so events get a testable `occurredAt`. */
export interface Clock {
  /**
   * @returns The current instant. A new `Date` on every call.
   */
  now: () => Date;
}

/** The real clock. */
export class SystemClock implements Clock {
  /**
   * @returns The current system time.
   */
  now(): Date {
    return new Date();
  }
}
