const ARGON2ID_PHC_VERSION = 19;
const BASE64_DIGITS = '[A-Za-z0-9+/]+';
const INTEGER = '(0|[1-9][0-9]{0,9})';
const ARGON2ID_PHC_PATTERN = new RegExp(
  `^\\$argon2id\\$v=${String(ARGON2ID_PHC_VERSION)}\\$m=${INTEGER},t=${INTEGER},p=${INTEGER}\\$(${BASE64_DIGITS})\\$(${BASE64_DIGITS})$`,
);
const BASE64_PADDING_PATTERN = /=+$/;
const MIN_MEMORY_KIB_PER_LANE = 8;

/**
 * Bounds applied to every stored hash before it is used. The values in a stored string come from
 * the database, so a tampered row must not be able to ask for gigabytes of memory.
 */
export const ARGON2ID_PHC_LIMITS = {
  maxMemoryKib: 256 * 1024,
  maxPasses: 10,
  maxParallelism: 16,
  minSaltBytes: 8,
  maxSaltBytes: 64,
  minTagBytes: 16,
  maxTagBytes: 64,
} as const;

/** The pieces of an argon2id hash. */
export interface Argon2idPhc {
  /** Memory cost in KiB (the `m` parameter). */
  readonly memoryKib: number;
  /** Number of passes (the `t` parameter). */
  readonly passes: number;
  /** Number of lanes (the `p` parameter). */
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}

/**
 * Encodes bytes as unpadded standard base64, the form PHC strings use.
 *
 * @param bytes - The bytes to encode.
 * @returns The base64 text without `=` padding.
 */
function encodeBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(BASE64_PADDING_PATTERN, '');
}

/**
 * Decodes unpadded standard base64, accepting only the canonical form.
 *
 * @param text - Base64 text without padding.
 * @returns The bytes, or null when the text is not canonical base64.
 */
function decodeBase64(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64');
  return encodeBase64(bytes) === text ? bytes : null;
}

/**
 * @param value - A number read from a stored hash.
 * @param minimum - Smallest accepted value.
 * @param maximum - Largest accepted value.
 * @returns True when the value lies in the closed range.
 */
function isInRange(value: number, minimum: number, maximum: number): boolean {
  return value >= minimum && value <= maximum;
}

/**
 * Writes an argon2id hash as a PHC string: `$argon2id$v=19$m=…,t=…,p=…$salt$hash`.
 *
 * @param phc - The parameters, salt and derived tag.
 * @returns The string to store.
 */
export function formatArgon2idPhc(phc: Argon2idPhc): string {
  const parameters = `m=${String(phc.memoryKib)},t=${String(phc.passes)},p=${String(phc.parallelism)}`;
  return `$argon2id$v=${String(ARGON2ID_PHC_VERSION)}$${parameters}$${encodeBase64(phc.salt)}$${encodeBase64(phc.tag)}`;
}

/**
 * Reads a PHC string back into its parts, refusing anything that is not a well-formed argon2id
 * hash inside `ARGON2ID_PHC_LIMITS`.
 *
 * @param encoded - A stored hash, which may be damaged or hostile.
 * @returns The parts, or null when the string is malformed, another algorithm, or out of bounds.
 */
export function parseArgon2idPhc(encoded: string): Argon2idPhc | null {
  const match = ARGON2ID_PHC_PATTERN.exec(encoded);
  if (match === null) {
    return null;
  }
  const [, memory = '', passes = '', parallelism = '', saltText = '', tagText = ''] = match;
  const memoryKib = Number(memory);
  const limits = ARGON2ID_PHC_LIMITS;
  const salt = decodeBase64(saltText);
  const tag = decodeBase64(tagText);
  if (salt === null || tag === null) {
    return null;
  }
  const phc: Argon2idPhc = {
    memoryKib,
    passes: Number(passes),
    parallelism: Number(parallelism),
    salt,
    tag,
  };
  const isWithinLimits =
    isInRange(phc.parallelism, 1, limits.maxParallelism) &&
    isInRange(phc.passes, 1, limits.maxPasses) &&
    isInRange(memoryKib, MIN_MEMORY_KIB_PER_LANE * phc.parallelism, limits.maxMemoryKib) &&
    isInRange(salt.length, limits.minSaltBytes, limits.maxSaltBytes) &&
    isInRange(tag.length, limits.minTagBytes, limits.maxTagBytes);
  return isWithinLimits ? phc : null;
}
