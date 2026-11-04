import { type IdGenerator } from '../../src/id-generator';

const FIRST_SEQUENCE_NUMBER = 1;
const UUID_LAST_GROUP_LENGTH = 12;

/** Hands out valid, predictable UUIDs (`00000000-0000-4000-8000-000000000001`, then `...02`). */
export class SequentialIdGenerator implements IdGenerator {
  private nextNumber = FIRST_SEQUENCE_NUMBER;

  /**
   * @returns The next UUID in the sequence.
   */
  generate(): string {
    const lastGroup = String(this.nextNumber).padStart(UUID_LAST_GROUP_LENGTH, '0');
    this.nextNumber += 1;
    return `00000000-0000-4000-8000-${lastGroup}`;
  }
}
