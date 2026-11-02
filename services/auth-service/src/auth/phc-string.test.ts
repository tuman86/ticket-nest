import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_PHC_LIMITS,
  formatArgon2idPhc,
  parseArgon2idPhc,
  type Argon2idPhc,
} from './phc-string';

const SALT = Buffer.alloc(16, 7);
const TAG = Buffer.alloc(32, 9);
const SALT_B64 = SALT.toString('base64').replace(/=+$/, '');
const TAG_B64 = TAG.toString('base64').replace(/=+$/, '');

const valid: Argon2idPhc = { memoryKib: 19_456, passes: 2, parallelism: 1, salt: SALT, tag: TAG };

describe('formatArgon2idPhc', () => {
  it('writes the standard PHC layout with unpadded base64', () => {
    expect(formatArgon2idPhc(valid)).toBe(`$argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`);
  });
});

describe('parseArgon2idPhc', () => {
  it('round-trips what formatArgon2idPhc wrote', () => {
    expect(parseArgon2idPhc(formatArgon2idPhc(valid))).toEqual(valid);
  });

  it.each([
    ['empty string', ''],
    ['plain text', 'not a hash'],
    ['only the prefix', '$argon2id$'],
    ['the argon2i variant', `$argon2i$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`],
    ['the argon2d variant', `$argon2d$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`],
    ['an old version', `$argon2id$v=16$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`],
    ['no version', `$argon2id$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`],
    ['a missing parameter', `$argon2id$v=19$m=19456,t=2$${SALT_B64}$${TAG_B64}`],
    ['parameters in another order', `$argon2id$v=19$t=2,m=19456,p=1$${SALT_B64}$${TAG_B64}`],
    ['a non-numeric parameter', `$argon2id$v=19$m=abc,t=2,p=1$${SALT_B64}$${TAG_B64}`],
    ['a fractional parameter', `$argon2id$v=19$m=19456,t=2.5,p=1$${SALT_B64}$${TAG_B64}`],
    ['a negative parameter', `$argon2id$v=19$m=19456,t=-2,p=1$${SALT_B64}$${TAG_B64}`],
    ['an empty salt', `$argon2id$v=19$m=19456,t=2,p=1$$${TAG_B64}`],
    ['an empty tag', `$argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$`],
    ['a salt that is not base64', `$argon2id$v=19$m=19456,t=2,p=1$!!!!!!!!!!!!!!!!$${TAG_B64}`],
    ['a padded tag', `$argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}=`],
    ['trailing data', `$argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}$extra`],
    ['a leading space', ` $argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$${TAG_B64}`],
  ])('returns null for %s', (_label, encoded) => {
    expect(parseArgon2idPhc(encoded)).toBeNull();
  });

  it('refuses parameters outside the safe bounds, so a tampered row cannot exhaust memory', () => {
    const encode = (overrides: Partial<Argon2idPhc>): string =>
      formatArgon2idPhc({ ...valid, ...overrides });

    expect(
      parseArgon2idPhc(encode({ memoryKib: ARGON2ID_PHC_LIMITS.maxMemoryKib + 1 })),
    ).toBeNull();
    expect(parseArgon2idPhc(encode({ passes: ARGON2ID_PHC_LIMITS.maxPasses + 1 }))).toBeNull();
    expect(
      parseArgon2idPhc(encode({ parallelism: ARGON2ID_PHC_LIMITS.maxParallelism + 1 })),
    ).toBeNull();
    expect(parseArgon2idPhc(encode({ passes: 0 }))).toBeNull();
    expect(parseArgon2idPhc(encode({ parallelism: 0 }))).toBeNull();
    // Argon2 needs at least 8 KiB per lane.
    expect(parseArgon2idPhc(encode({ memoryKib: 31, parallelism: 4 }))).toBeNull();
    expect(
      parseArgon2idPhc(encode({ salt: Buffer.alloc(ARGON2ID_PHC_LIMITS.minSaltBytes - 1) })),
    ).toBeNull();
    expect(
      parseArgon2idPhc(encode({ tag: Buffer.alloc(ARGON2ID_PHC_LIMITS.minTagBytes - 1) })),
    ).toBeNull();
    expect(
      parseArgon2idPhc(encode({ tag: Buffer.alloc(ARGON2ID_PHC_LIMITS.maxTagBytes + 1) })),
    ).toBeNull();
  });

  it('accepts parameters at the bounds', () => {
    const atMaximum = {
      ...valid,
      memoryKib: ARGON2ID_PHC_LIMITS.maxMemoryKib,
      passes: ARGON2ID_PHC_LIMITS.maxPasses,
      parallelism: ARGON2ID_PHC_LIMITS.maxParallelism,
    };
    expect(parseArgon2idPhc(formatArgon2idPhc(atMaximum))).toEqual(atMaximum);
  });
});
