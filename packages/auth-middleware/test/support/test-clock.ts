/** A clock that follows real time plus an offset, so a test can jump forward without sleeping. */
export class TestClock {
  private offsetMs = 0;

  /** @returns The current time including any jumps. */
  now = (): Date => new Date(Date.now() + this.offsetMs);

  /**
   * Moves the clock forward.
   *
   * @param milliseconds - How far to jump.
   */
  advance(milliseconds: number): void {
    this.offsetMs += milliseconds;
  }
}
