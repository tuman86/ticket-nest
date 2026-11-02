import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_PASSES,
  ARGON2ID_SALT_BYTES,
  ARGON2ID_TAG_BYTES,
  Argon2idPasswordHasher,
} from './argon2id-password-hasher';
import { assertArgon2Available, deriveArgon2idTag } from './argon2id-tag';
import { formatArgon2idPhc, parseArgon2idPhc } from './phc-string';

const PASSWORD = 'correct-horse-battery-staple';
const SHAPE = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

describe('the chosen parameters', () => {
  it('are not below the OWASP minimum for argon2id (19 MiB, 2 passes, 1 lane)', () => {
    expect(ARGON2ID_MEMORY_KIB).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2ID_PASSES).toBeGreaterThanOrEqual(2);
    expect(ARGON2ID_PARALLELISM).toBeGreaterThanOrEqual(1);
    expect(ARGON2ID_SALT_BYTES).toBe(16);
  });

  it('are refused by the constructor when an override goes below that minimum', () => {
    expect(() => new Argon2idPasswordHasher({ memoryKib: 19_455 })).toThrow(RangeError);
    expect(() => new Argon2idPasswordHasher({ passes: 1 })).toThrow(RangeError);
    expect(() => new Argon2idPasswordHasher({ parallelism: 0 })).toThrow(RangeError);
  });
});

describe('Argon2idPasswordHasher', () => {
  const hasher = new Argon2idPasswordHasher();

  it('hashes to a PHC string and verifies the same password (round trip)', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(hash).toMatch(SHAPE);
    expect(await hasher.verify(PASSWORD, hash)).toBe(true);
  });

  it('does not contain the password in the hash', async () => {
    expect(await hasher.hash(PASSWORD)).not.toContain(PASSWORD);
  });

  it('rejects a wrong password, including a near miss', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(await hasher.verify('wrong-password-entirely', hash)).toBe(false);
    expect(await hasher.verify(`${PASSWORD} `, hash)).toBe(false);
    expect(await hasher.verify(PASSWORD.toUpperCase(), hash)).toBe(false);
    expect(await hasher.verify('', hash)).toBe(false);
  });

  it('uses a fresh 16-byte random salt every time', async () => {
    const hashes = await Promise.all([
      hasher.hash(PASSWORD),
      hasher.hash(PASSWORD),
      hasher.hash(PASSWORD),
    ]);

    const salts = hashes.map((hash) => parseArgon2idPhc(hash)?.salt.toString('hex'));
    expect(new Set(hashes).size).toBe(3);
    expect(new Set(salts).size).toBe(3);
    for (const hash of hashes) {
      expect(parseArgon2idPhc(hash)?.salt).toHaveLength(ARGON2ID_SALT_BYTES);
      expect(parseArgon2idPhc(hash)?.tag).toHaveLength(ARGON2ID_TAG_BYTES);
    }
  });

  it('handles unicode, long and whitespace-only passwords', async () => {
    for (const password of ['pässwörd-日本語-🔐', 'x'.repeat(128), '          ']) {
      const hash = await hasher.hash(password);
      expect(await hasher.verify(password, hash)).toBe(true);
    }
  });

  it.each([
    ['empty', ''],
    ['plain text', 'not-a-hash'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuK1b1wMEVjv7Zr6Rb3gXVv1QQK1u3YJe'],
    [
      'the wrong argon2 variant',
      '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
    ],
    ['a truncated hash', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA'],
    [
      'a tag that is not base64',
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$%%%%%%%%%%%%%%%%%%%%%%%%',
    ],
    [
      'a memory cost that would exhaust the host',
      '$argon2id$v=19$m=4194304,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
    ],
  ])(
    'treats a malformed stored hash (%s) as a failed verification, not an error',
    async (_label, stored) => {
      await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(false);
    },
  );

  it('rejects a hash whose tag was altered by one character', async () => {
    const hash = await hasher.hash(PASSWORD);
    const last = hash.at(-1);
    const tampered = `${hash.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

    expect(await hasher.verify(PASSWORD, tampered)).toBe(false);
  });

  it('reads the parameters from the stored string, not from its own settings', async () => {
    const stronger = new Argon2idPasswordHasher({ memoryKib: 32_768, passes: 3 });
    const hashedByStronger = await stronger.hash(PASSWORD);

    expect(hashedByStronger).toContain('m=32768,t=3,p=1');
    expect(await hasher.verify(PASSWORD, hashedByStronger)).toBe(true);
    expect(await stronger.verify(PASSWORD, await hasher.hash(PASSWORD))).toBe(true);
  });
});

describe('reference vectors', () => {
  it('matches the argon2id test vector of RFC 9106 section 5.3', async () => {
    const tag = await deriveArgon2idTag({
      password: Buffer.alloc(32, 0x01),
      salt: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memoryKib: 32,
      passes: 3,
      parallelism: 4,
      tagBytes: 32,
    });

    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('verifies a hash written by another implementation (argon2-cffi documentation example)', async () => {
    const hasher = new Argon2idPasswordHasher();
    const stored =
      '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg';

    expect(await hasher.verify('correct horse battery staple', stored)).toBe(true);
    expect(await hasher.verify('correct horse battery stapl', stored)).toBe(false);
  });

  it('writes the PHC string for the RFC inputs the same way it reads it', async () => {
    const salt = Buffer.from('MIIRqgvgQbgj220jfp0MPA', 'base64');
    const tag = await deriveArgon2idTag({
      password: Buffer.from('correct horse battery staple'),
      salt,
      memoryKib: 65_536,
      passes: 3,
      parallelism: 4,
      tagBytes: 32,
    });

    expect(formatArgon2idPhc({ memoryKib: 65_536, passes: 3, parallelism: 4, salt, tag })).toBe(
      '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg',
    );
  });
});

describe('assertArgon2Available', () => {
  it('passes on the running Node', () => {
    expect(() => {
      assertArgon2Available();
    }).not.toThrow();
  });

  it('fails fast, naming the required Node version, when crypto.argon2 is missing', () => {
    expect(() => {
      assertArgon2Available({});
    }).toThrow(/24\.7/);
  });
});
