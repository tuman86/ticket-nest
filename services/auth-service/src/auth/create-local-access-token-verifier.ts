import { type KeyObject } from 'node:crypto';

import {
  type AccessTokenVerifier,
  JwtAccessTokenVerifier,
  StaticKeyResolver,
} from '@ticketnest/auth-middleware';

/**
 * No tolerance past `exp` for auth-service's own verifier. The shared verifier allows a few seconds
 * of drift between a signer and a verifier on different machines, but here both are the same
 * service on the same clock, so a token is refused the moment it expires.
 */
const LOCAL_CLOCK_TOLERANCE_MS = 0;

export interface LocalAccessTokenVerifierOptions {
  /** The same public keys the JWKS endpoint publishes, by `kid`. */
  readonly verificationKeys: ReadonlyMap<string, KeyObject>;
  readonly issuer: string;
  readonly audience: string;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/**
 * Builds the verifier auth-service uses for its own routes. It reads keys from memory instead of
 * calling its own JWKS endpoint, and it has no clock tolerance. Production and the test apps both
 * build it here, so the two cannot drift apart.
 *
 * @param options - The keys, issuer, audience and optional clock.
 * @returns A verifier for access tokens signed by this service.
 * @throws TypeError when there are no keys or any key is not an Ed25519 public key.
 */
export function createLocalAccessTokenVerifier(
  options: LocalAccessTokenVerifierOptions,
): AccessTokenVerifier {
  return new JwtAccessTokenVerifier({
    keyResolver: new StaticKeyResolver(options.verificationKeys),
    issuer: options.issuer,
    audience: options.audience,
    clockToleranceMs: LOCAL_CLOCK_TOLERANCE_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
