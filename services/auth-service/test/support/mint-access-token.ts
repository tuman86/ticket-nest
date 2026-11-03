import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';

import { SignJWT } from 'jose';

import { TEST_AUDIENCE, TEST_ISSUER, TEST_KEY_ID } from './test-signing-keys';

const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_LIFETIME_SECONDS = 600;

export interface MintAccessTokenOptions {
  /** Key that signs the token. Must be an Ed25519 private key unless `algorithm` says otherwise. */
  readonly privateKey: KeyObject | Uint8Array;
  /** Signing algorithm. Defaults to `EdDSA`. */
  readonly algorithm?: string;
  /** `kid` header. `null` leaves it out. Defaults to the test key id. */
  readonly keyId?: string | null;
  readonly issuer?: string;
  readonly audience?: string;
  /** `sub` claim. `null` leaves it out. */
  readonly subject?: string | null;
  /** Issue time. Defaults to now. */
  readonly issuedAt?: Date;
  /** Lifetime in seconds from `issuedAt`. Defaults to 10 minutes. */
  readonly lifetimeSeconds?: number;
  /** Claims that replace or add to the defaults (`role`, `permissions`, `auth_time`, ...). */
  readonly claims?: Record<string, unknown>;
}

/**
 * Signs an access token shaped like the ones auth-service issues, with every part overridable so a
 * test can build a token that is wrong in exactly one way.
 *
 * @param options - Key and the parts to override.
 * @returns A compact JWT.
 */
export async function mintAccessToken(options: MintAccessTokenOptions): Promise<string> {
  const issuedAtSeconds = Math.floor(
    (options.issuedAt ?? new Date()).getTime() / MILLISECONDS_PER_SECOND,
  );
  const keyId = options.keyId === undefined ? TEST_KEY_ID : options.keyId;
  const builder = new SignJWT({
    role: 'CUSTOMER',
    permissions: [],
    auth_time: issuedAtSeconds,
    ...options.claims,
  })
    .setProtectedHeader({
      alg: options.algorithm ?? 'EdDSA',
      ...(keyId === null ? {} : { kid: keyId }),
    })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + (options.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS));
  if (options.subject !== null) {
    builder.setSubject(options.subject ?? randomUUID());
  }
  return builder.sign(options.privateKey);
}

/**
 * @param value - Any JSON-serializable value.
 * @returns Its JSON as base64url, the way JWT segments are written.
 */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Builds a token that claims `alg: none` and has an empty signature.
 *
 * @param payload - Claims to put in the token.
 * @returns A compact JWT with no signature.
 */
export function forgeUnsignedToken(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment(payload)}.`;
}

/**
 * Changes a claim in a signed token without re-signing it, so the signature no longer matches.
 *
 * @param token - A compact JWT.
 * @param changes - Claims to overwrite in the payload.
 * @returns The token with the new payload and the old signature.
 */
export function tamperWithPayload(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  return `${header ?? ''}.${encodeSegment({ ...claims, ...changes })}.${signature ?? ''}`;
}

/** @returns A fresh RSA private key, for tests that present an RS256 token. */
export function generateRsaPrivateKey(): KeyObject {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}
