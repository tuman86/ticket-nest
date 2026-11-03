import { randomBytes, timingSafeEqual } from 'node:crypto';

import { assertArgon2Available, deriveArgon2idTag } from './argon2id-tag';
import { type PasswordHasher } from './password-hasher';
import { formatArgon2idPhc, parseArgon2idPhc } from './phc-string';

/** OWASP minimum for argon2id: 19 MiB of memory, 2 passes, 1 lane. Raise these, never lower them. */
const OWASP_MINIMUM_MEMORY_KIB = 19 * 1024;
const OWASP_MINIMUM_PASSES = 2;
const OWASP_MINIMUM_PARALLELISM = 1;

export const ARGON2ID_MEMORY_KIB = OWASP_MINIMUM_MEMORY_KIB;
export const ARGON2ID_PASSES = OWASP_MINIMUM_PASSES;
export const ARGON2ID_PARALLELISM = OWASP_MINIMUM_PARALLELISM;
export const ARGON2ID_SALT_BYTES = 16;
export const ARGON2ID_TAG_BYTES = 32;

export interface Argon2idOptions {
  /** Memory cost in KiB. Not below 19 456. */
  readonly memoryKib?: number;
  /** Passes over memory. Not below 2. */
  readonly passes?: number;
  /** Lanes. Not below 1. */
  readonly parallelism?: number;
}

/** `PasswordHasher` using argon2id from Node's built-in `crypto.argon2`. */
export class Argon2idPasswordHasher implements PasswordHasher {
  private readonly memoryKib: number;
  private readonly passes: number;
  private readonly parallelism: number;

  /**
   * @param options - Cost overrides for new hashes. Defaults to the named constants.
   * @throws InternalServerError when this Node has no `crypto.argon2`.
   * @throws RangeError when an override is below the OWASP minimum.
   */
  constructor(options: Argon2idOptions = {}) {
    assertArgon2Available();
    this.memoryKib = options.memoryKib ?? ARGON2ID_MEMORY_KIB;
    this.passes = options.passes ?? ARGON2ID_PASSES;
    this.parallelism = options.parallelism ?? ARGON2ID_PARALLELISM;
    if (
      this.memoryKib < OWASP_MINIMUM_MEMORY_KIB ||
      this.passes < OWASP_MINIMUM_PASSES ||
      this.parallelism < OWASP_MINIMUM_PARALLELISM
    ) {
      throw new RangeError('Argon2id parameters are below the OWASP minimum.');
    }
  }

  /**
   * Hashes a password with argon2id and a new random 16-byte salt.
   *
   * @param password - The plaintext password.
   * @returns A PHC string carrying the parameters, salt and hash.
   */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(ARGON2ID_SALT_BYTES);
    const tag = await deriveArgon2idTag({
      password: Buffer.from(password, 'utf8'),
      salt,
      memoryKib: this.memoryKib,
      passes: this.passes,
      parallelism: this.parallelism,
      tagBytes: ARGON2ID_TAG_BYTES,
    });
    return formatArgon2idPhc({
      memoryKib: this.memoryKib,
      passes: this.passes,
      parallelism: this.parallelism,
      salt,
      tag,
    });
  }

  /**
   * Re-derives the hash with the parameters stored in `storedHash` (so older hashes keep working
   * after the constants are raised) and compares in constant time.
   *
   * @param password - The plaintext password to check.
   * @param storedHash - A PHC string from `hash`.
   * @returns True when the password matches. False for a wrong password or a malformed hash.
   */
  async verify(password: string, storedHash: string): Promise<boolean> {
    const stored = parseArgon2idPhc(storedHash);
    if (stored === null) {
      return false;
    }
    const candidate = await deriveArgon2idTag({
      password: Buffer.from(password, 'utf8'),
      salt: stored.salt,
      memoryKib: stored.memoryKib,
      passes: stored.passes,
      parallelism: stored.parallelism,
      tagBytes: stored.tag.length,
    });
    return timingSafeEqual(candidate, stored.tag);
  }
}
