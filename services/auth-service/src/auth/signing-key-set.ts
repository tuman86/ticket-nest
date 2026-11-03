import { createPublicKey, type KeyObject } from 'node:crypto';

import { ACCESS_TOKEN_ALGORITHM } from '@ticketnest/auth-middleware';
import { ConfigError } from '@ticketnest/config';
import { Jwk } from '@ticketnest/contracts';
import { calculateJwkThumbprint } from 'jose';

const SIGNING_KEY_VARIABLE = 'JWT_PRIVATE_KEY';
const ADDITIONAL_KEYS_VARIABLE = 'JWT_ADDITIONAL_PUBLIC_KEYS';

export interface SigningKeySetInput {
  /** The Ed25519 key that signs every new access token. */
  readonly privateKey: KeyObject;
  /** Verify-only public keys: a retiring key still needed by live tokens, or an upcoming key. */
  readonly additionalPublicKeys: readonly KeyObject[];
}

/**
 * The one source of truth for access-token keys. The token service signs with
 * `signingPrivateKey`, the `/me` verifier checks against `verificationKeys` and the JWKS endpoint
 * publishes `publicJwks`, so the three cannot disagree.
 */
export interface SigningKeySet {
  /** RFC 7638 thumbprint of the signing key: the `kid` header of every token it signs. */
  readonly signingKeyId: string;
  /** Held by auth-service only. Never passed to anything that publishes or logs. */
  readonly signingPrivateKey: KeyObject;
  /** Every published public key by `kid`, the signing key included. */
  readonly verificationKeys: ReadonlyMap<string, KeyObject>;
  /** The public JWKs: the signing key first, then the others sorted by `kid`. */
  readonly publicJwks: readonly Jwk[];
}

interface PublicKeyEntry {
  readonly jwk: Jwk;
  readonly publicKey: KeyObject;
}

/**
 * Builds a startup failure that names the variable and the problem, never any key material.
 *
 * @param problem - Variable name and reason, for example `JWT_ADDITIONAL_PUBLIC_KEYS[0]: must be ...`.
 * @returns The error to throw.
 */
function invalidKeySet(problem: string): ConfigError {
  return new ConfigError(`Invalid signing key configuration:\n  - ${problem}`, [problem]);
}

/**
 * Derives the JWK of a public key and its RFC 7638 thumbprint. Only the public members `kty`,
 * `crv` and `x` are ever read, and the result must pass the strict `Jwk` contract.
 *
 * @param publicKey - An Ed25519 public key.
 * @returns The key as published, with `use`, `alg` and `kid` added.
 * @throws ConfigError when the key has no exportable public member.
 */
async function toPublicKeyEntry(publicKey: KeyObject): Promise<PublicKeyEntry> {
  const { x } = publicKey.export({ format: 'jwk' });
  if (x === undefined) {
    throw invalidKeySet('a public key could not be exported as a JWK');
  }
  const members = { kty: 'OKP', crv: 'Ed25519', x } as const;
  const kid = await calculateJwkThumbprint(members);
  const jwk = Jwk.parse({ ...members, use: 'sig', alg: ACCESS_TOKEN_ALGORITHM, kid });
  return { jwk, publicKey };
}

/**
 * Creates the key set once at startup. The public key is derived from the private key first and
 * only that public key object is exported, so private members cannot reach the JWK.
 *
 * @param input - The signing private key and any verify-only public keys.
 * @returns The key set shared by the token service, the verifier and the JWKS endpoint.
 * @throws ConfigError when a key is not Ed25519 or of the wrong kind, or two keys are the same.
 */
export async function createSigningKeySet(input: SigningKeySetInput): Promise<SigningKeySet> {
  const { privateKey, additionalPublicKeys } = input;
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw invalidKeySet(`${SIGNING_KEY_VARIABLE}: must be an Ed25519 private key`);
  }
  additionalPublicKeys.forEach((key, index) => {
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw invalidKeySet(
        `${ADDITIONAL_KEYS_VARIABLE}[${String(index)}]: must be an Ed25519 public key`,
      );
    }
  });

  const signing = await toPublicKeyEntry(createPublicKey(privateKey));
  const others = await Promise.all(additionalPublicKeys.map(toPublicKeyEntry));
  const seen = new Set([signing.jwk.kid]);
  others.forEach((entry, index) => {
    if (seen.has(entry.jwk.kid)) {
      throw invalidKeySet(
        `${ADDITIONAL_KEYS_VARIABLE}[${String(index)}]: duplicates the signing key or another listed key`,
      );
    }
    seen.add(entry.jwk.kid);
  });

  const published = [
    signing,
    ...[...others].sort((first, second) => (first.jwk.kid < second.jwk.kid ? -1 : 1)),
  ];
  return {
    signingKeyId: signing.jwk.kid,
    signingPrivateKey: privateKey,
    verificationKeys: new Map(published.map((entry) => [entry.jwk.kid, entry.publicKey])),
    publicJwks: published.map((entry) => entry.jwk),
  };
}
