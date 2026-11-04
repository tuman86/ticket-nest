import { randomUUID } from 'node:crypto';

/** Source of unique event ids. Injected so tests get predictable ids. */
export interface IdGenerator {
  /**
   * @returns A new UUID, unique across every service.
   */
  generate: () => string;
}

/** Generates random version 4 UUIDs with Node's `crypto`. */
export class UuidGenerator implements IdGenerator {
  /**
   * @returns A random UUID v4.
   */
  generate(): string {
    return randomUUID();
  }
}
