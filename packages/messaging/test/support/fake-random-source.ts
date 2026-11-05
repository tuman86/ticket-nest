import { type RandomSource } from '../../src/relay/random-source';

/** A random source that always returns the same number, so a test can pick a point in a window. */
export class FakeRandomSource implements RandomSource {
  /**
   * @param value - What every `next()` call returns, from 0 up to and including 1.
   */
  constructor(private readonly value: number) {}

  /**
   * @returns The fixed number.
   */
  next(): number {
    return this.value;
  }
}
