import { createPublicKey, type KeyObject } from 'node:crypto';

import { Jwk } from '@ticketnest/contracts';
import { z } from 'zod';

const JwksDocument = z.object({ keys: z.array(z.unknown()) });

export interface ParsedVerificationKeys {
  /** Usable Ed25519 public keys by `kid`. Never empty. */
  readonly keys: ReadonlyMap<string, KeyObject>;
  /** Keys in the document that were left out because they cannot verify an access token. */
  readonly skippedKeyCount: number;
}

/**
 * Turns an untrusted key set document into public keys. It trusts nothing: each key must pass the
 * strict `Jwk` contract (Ed25519, `use: sig`, `alg: EdDSA`, no private member), so a key of
 * another type is skipped and never used, and one bad key does not hide the others.
 *
 * @param document - The parsed JSON the JWKS endpoint answered.
 * @returns The usable keys and how many were skipped.
 * @throws Error when the document is not a key set, or none of its keys is usable. A key set with
 * no key must never replace a working one.
 */
export function parseVerificationKeys(document: unknown): ParsedVerificationKeys {
  const parsedDocument = JwksDocument.safeParse(document);
  if (!parsedDocument.success) {
    throw new Error('The JWKS document is not a key set.');
  }
  const keys = new Map<string, KeyObject>();
  for (const candidate of parsedDocument.data.keys) {
    const jwk = Jwk.safeParse(candidate);
    if (jwk.success && !keys.has(jwk.data.kid)) {
      keys.set(jwk.data.kid, importPublicKey(jwk.data));
    }
  }
  if (keys.size === 0) {
    throw new Error('The JWKS document has no usable key.');
  }
  return { keys, skippedKeyCount: parsedDocument.data.keys.length - keys.size };
}

/**
 * @param jwk - A key that passed the `Jwk` contract.
 * @returns The Ed25519 public key. Only the public members are passed to the importer.
 */
function importPublicKey(jwk: Jwk): KeyObject {
  return createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
}
