/**
 * A clock for tests. By default it follows real time plus an offset, so a test can jump forward
 * without sleeping. It can also be frozen at an exact instant, for a test whose outcome must not
 * depend on how long the test itself takes to run.
 */
export class TestClock {
  private offsetMs = 0;
  private frozenAt: Date | null = null;

  /** @returns The frozen instant when there is one, otherwise real time including any jumps. */
  now = (): Date =>
    this.frozenAt === null
      ? new Date(Date.now() + this.offsetMs)
      : new Date(this.frozenAt.getTime());

  /**
   * Moves the clock forward. It has no effect on a frozen clock until it is unfrozen.
   *
   * @param milliseconds - How far to jump.
   */
  advance(milliseconds: number): void {
    this.offsetMs += milliseconds;
  }

  /**
   * Stops the clock at an exact instant, so time that passes while the test runs changes nothing.
   *
   * @param instant - What `now` returns until `unfreeze` is called.
   */
  freezeAt(instant: Date): void {
    this.frozenAt = new Date(instant.getTime());
  }

  /** Lets the clock follow real time again, with its offset. */
  unfreeze(): void {
    this.frozenAt = null;
  }
}
