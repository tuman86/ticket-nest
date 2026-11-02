import * as nodeCrypto from 'node:crypto';

import { InternalServerError } from '@ticketnest/errors';

const MINIMUM_NODE_VERSION = '24.7.0';

export interface DeriveArgon2idTagInput {
  /** The plaintext password bytes. */
  readonly password: Buffer;
  readonly salt: Buffer;
  /** Memory cost in KiB. */
  readonly memoryKib: number;
  readonly passes: number;
  readonly parallelism: number;
  /** Length of the output in bytes. */
  readonly tagBytes: number;
  /** Optional keyed-hash input ("pepper"). Not used by the service yet. */
  readonly secret?: Buffer;
  readonly associatedData?: Buffer;
}

/**
 * Fails fast when this Node has no built-in argon2 (added in Node 24.7), so a wrong runtime is
 * caught at startup instead of at the first sign-up.
 *
 * @param cryptoModule - The module to inspect. Defaults to `node:crypto`; tests pass a stand-in.
 * @throws InternalServerError when `argon2` is not a function.
 */
export function assertArgon2Available(
  cryptoModule: { readonly argon2?: unknown } = nodeCrypto,
): void {
  if (typeof cryptoModule.argon2 !== 'function') {
    throw new InternalServerError({
      detail: `crypto.argon2 is not available. Node ${MINIMUM_NODE_VERSION} or newer is required.`,
    });
  }
}

/**
 * Runs argon2id on the libuv thread pool, so the event loop stays free while it works.
 *
 * @param input - The password, salt and cost parameters.
 * @returns The raw derived bytes (`tagBytes` long).
 */
export function deriveArgon2idTag(input: DeriveArgon2idTagInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeCrypto.argon2(
      'argon2id',
      {
        message: input.password,
        nonce: input.salt,
        memory: input.memoryKib,
        passes: input.passes,
        parallelism: input.parallelism,
        tagLength: input.tagBytes,
        ...(input.secret === undefined ? {} : { secret: input.secret }),
        ...(input.associatedData === undefined ? {} : { associatedData: input.associatedData }),
      },
      (error, derivedKey) => {
        if (error === null) {
          resolve(derivedKey);
        } else {
          reject(error);
        }
      },
    );
  });
}
