import { type KeyObject } from 'node:crypto';

import { type KeyResolver } from './key-resolver';

/**
 * Resolves keys from a map held in memory. auth-service uses it with the same key set its JWKS
 * endpoint publishes, so it verifies its own tokens without calling itself over HTTP. Tests use it
 * too.
 */
export class StaticKeyResolver implements KeyResolver {
  /**
   * @param verificationKeys - Public keys by `kid`.
   * @throws TypeError when the map is empty or any key is not an Ed25519 public key.
   */
  constructor(private readonly verificationKeys: ReadonlyMap<string, KeyObject>) {
    const keys = [...verificationKeys.values()];
    if (
      keys.length === 0 ||
      keys.some((key) => key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
    ) {
      throw new TypeError('The verification keys must be a non-empty set of Ed25519 public keys.');
    }
  }

  /**
   * @param keyId - The `kid` from the token header.
   * @returns The key, or `undefined` for a `kid` that is not in the map. A `Map` is used so names
   * an object would inherit (`constructor`, `__proto__`) are never found.
   */
  resolveKey(keyId: string): Promise<KeyObject | undefined> {
    return Promise.resolve(this.verificationKeys.get(keyId));
  }
}
