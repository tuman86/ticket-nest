import { z } from 'zod';

/**
 * One public signing key as published at `/.well-known/jwks.json`: Ed25519 (RFC 8037), the only
 * key type access tokens use (ADR-0013). Strict on purpose: a key that carries a private member
 * (`d`, `p`, `q`, `dp`, `dq`, `qi`) or any unknown member fails to parse, so a producer cannot
 * publish one by accident and a verifier never trusts one.
 */
export const Jwk = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  /** The public key, base64url. */
  x: z.string().min(1),
  use: z.literal('sig'),
  alg: z.literal('EdDSA'),
  /** RFC 7638 SHA-256 thumbprint of the key, base64url. Equals the `kid` header of its tokens. */
  kid: z.string().min(1),
});
export type Jwk = z.infer<typeof Jwk>;

/** Response of `GET /.well-known/jwks.json`. Never empty: with no key no token could verify. */
export const Jwks = z.strictObject({
  keys: z.array(Jwk).min(1),
});
export type Jwks = z.infer<typeof Jwks>;
