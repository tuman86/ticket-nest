/** Source of random numbers. Injected so a test can fix the jitter of a backoff. */
export interface RandomSource {
  /**
   * @returns A number from 0 (inclusive) up to 1 (exclusive).
   */
  next: () => number;
}

/** Random numbers from `Math.random`. The jitter it feeds is not security sensitive. */
export class MathRandomSource implements RandomSource {
  /**
   * @returns A pseudo-random number from 0 (inclusive) up to 1 (exclusive).
   */
  next(): number {
    return Math.random();
  }
}
