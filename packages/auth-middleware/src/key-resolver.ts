import { type KeyObject } from 'node:crypto';

import { ServiceUnavailableError } from '@ticketnest/errors';

import { JWKS_UNAVAILABLE_RETRY_AFTER_SECONDS } from './jwks-constants';

const KEY_SET_UNAVAILABLE_CODE = 'KEY_SET_UNAVAILABLE';

/**
 * Finds the public key an access token's `kid` header names. It is the seam between the verifier
 * and where keys come from: auth-service holds its own keys in memory (`StaticKeyResolver`), every
 * other verifier fetches them from the JWKS endpoint (`JwksKeyResolver`).
 */
export interface KeyResolver {
  /**
   * Looks up one verification key.
   *
   * @param keyId - The `kid` from the token's protected header.
   * @returns The Ed25519 public key, or `undefined` when the key set does not contain that `kid`.
   * @throws KeySetUnavailableError when the key set cannot be loaded, so it is not known whether
   * the key exists.
   */
  resolveKey(keyId: string): Promise<KeyObject | undefined>;
}

/**
 * 503: the verification keys cannot be loaded (auth-service is unreachable and nothing usable is
 * cached). It is a server problem, not a bad token, so it is never reported as a 401: a client
 * with a good token would otherwise sign itself out. The response carries no detail and no cause.
 */
export class KeySetUnavailableError extends ServiceUnavailableError {
  /**
   * @param options - Optional cause, kept for the log only.
   */
  constructor(options: { readonly cause?: unknown } = {}) {
    super({
      ...options,
      code: KEY_SET_UNAVAILABLE_CODE,
      retryAfterSeconds: JWKS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }
}
