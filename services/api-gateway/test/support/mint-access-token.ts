import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';

import { getTestPrivateKey, TEST_AUDIENCE, TEST_ISSUER, TEST_KEY_ID } from './test-signing-keys';

const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_LIFETIME_SECONDS = 600;

export interface MintAccessTokenOptions {
  /** The `sub` claim. Defaults to a new UUID. */
  readonly subject?: string;
  /** Issue time. Defaults to now. Use a time in the past to build an expired token. */
  readonly issuedAt?: Date;
  readonly lifetimeSeconds?: number;
  readonly audience?: string;
}

/**
 * Signs an access token shaped like the ones auth-service issues, with the test key.
 *
 * @param options - Parts to override.
 * @returns A compact JWT that the gateway's real verifier accepts.
 */
export async function mintAccessToken(options: MintAccessTokenOptions = {}): Promise<string> {
  const issuedAtSeconds = Math.floor(
    (options.issuedAt ?? new Date()).getTime() / MILLISECONDS_PER_SECOND,
  );
  return new SignJWT({ role: 'CUSTOMER', permissions: [], auth_time: issuedAtSeconds })
    .setProtectedHeader({ alg: 'EdDSA', kid: TEST_KEY_ID })
    .setIssuer(TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setJti(randomUUID())
    .setSubject(options.subject ?? randomUUID())
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + (options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS))
    .sign(getTestPrivateKey());
}
