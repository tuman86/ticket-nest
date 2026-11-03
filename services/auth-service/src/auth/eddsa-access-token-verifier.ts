import { type KeyObject } from 'node:crypto';

import { Id } from '@ticketnest/contracts';
import { decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { z } from 'zod';

import { type AccessTokenVerifier } from './access-token-verifier';
import { type AuthenticatedPrincipal } from './authenticated-principal';
import { InvalidAccessTokenError } from './invalid-access-token.error';
import { ACCESS_TOKEN_ALGORITHM } from './token-constants';

const MILLISECONDS_PER_SECOND = 1000;
const REQUIRED_CLAIMS = ['sub', 'exp', 'iat', 'jti'];

/**
 * What an access token must carry. `sid` must be absent: guest tokens have one and no `sub`, and
 * must never pass as a user token. Extra claims are allowed.
 */
const AccessTokenPayload = z.looseObject({
  sub: Id,
  role: z.string().min(1),
  permissions: z.array(z.string()),
  auth_time: z.number().int().nonnegative(),
  jti: z.string().min(1),
  tenantId: Id.optional(),
  sid: z.never().optional(),
});

export interface EdDsaAccessTokenVerifierOptions {
  /** The Ed25519 public key that matches the signing key. */
  readonly publicKey: KeyObject;
  /** The only `kid` accepted. A key set arrives with the JWKS endpoint. */
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/**
 * Temporary access-token verifier for auth-service's own routes, built on `jose`. It accepts only
 * `EdDSA`, one configured `kid`, and the configured issuer and audience. The shared
 * `packages/auth-middleware` replaces it.
 */
export class EdDsaAccessTokenVerifier implements AccessTokenVerifier {
  private readonly now: () => Date;

  /**
   * @param options - Public key, key id, issuer, audience and optional clock.
   * @throws TypeError when `publicKey` is not an Ed25519 public key.
   */
  constructor(private readonly options: EdDsaAccessTokenVerifierOptions) {
    if (options.publicKey.type !== 'public' || options.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('The verification key must be an Ed25519 public key.');
    }
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Verifies algorithm, key id, signature, `iss`, `aud` and `exp`, then the shape of the claims.
   * Expiry has no tolerance: the signer and the verifier are the same service.
   *
   * @param token - The compact JWT.
   * @returns The caller the token names.
   * @throws InvalidAccessTokenError for every invalid token.
   */
  async verify(token: string): Promise<AuthenticatedPrincipal> {
    this.assertAlgorithmAndKeyId(token);
    try {
      const { payload } = await jwtVerify(token, this.options.publicKey, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.options.issuer,
        audience: this.options.audience,
        requiredClaims: REQUIRED_CLAIMS,
        currentDate: this.now(),
      });
      return this.toPrincipal(payload);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Refuses a token whose header names another algorithm or key before any signature work, so
   * `none`, HMAC and RSA tokens never reach the verifier.
   *
   * @param token - The compact JWT.
   * @throws InvalidAccessTokenError when the header is unreadable, or names another `alg` or `kid`.
   */
  private assertAlgorithmAndKeyId(token: string): void {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch (error) {
      throw new InvalidAccessTokenError('malformed_token', { cause: error });
    }
    if (header.alg !== ACCESS_TOKEN_ALGORITHM) {
      throw new InvalidAccessTokenError('unsupported_algorithm');
    }
    if (header.kid !== this.options.keyId) {
      throw new InvalidAccessTokenError('unknown_key_id');
    }
  }

  /**
   * @param payload - The verified claims.
   * @returns The caller.
   * @throws InvalidAccessTokenError when the claims do not have the shape of a user access token.
   */
  private toPrincipal(payload: unknown): AuthenticatedPrincipal {
    const parsed = AccessTokenPayload.safeParse(payload);
    if (!parsed.success) {
      throw new InvalidAccessTokenError('invalid_claims', { cause: parsed.error });
    }
    const claims = parsed.data;
    return {
      userId: claims.sub,
      roleKey: claims.role,
      permissions: claims.permissions,
      tenantId: claims.tenantId ?? null,
      authTime: new Date(claims.auth_time * MILLISECONDS_PER_SECOND),
      tokenId: claims.jti,
    };
  }

  /**
   * Maps a library error to the one public error, keeping the specific reason for the log.
   *
   * @param error - What `jwtVerify` or `toPrincipal` threw.
   * @returns The error to throw. Unexpected errors are returned unchanged (they become a 500).
   */
  private translate(error: unknown): unknown {
    if (error instanceof InvalidAccessTokenError) {
      return error;
    }
    const options = { cause: error };
    if (error instanceof errors.JWTExpired) {
      return new InvalidAccessTokenError('expired', options);
    }
    if (error instanceof errors.JWTClaimValidationFailed) {
      return new InvalidAccessTokenError(claimFailureReason(error.claim), options);
    }
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      return new InvalidAccessTokenError('bad_signature', options);
    }
    if (error instanceof errors.JOSEAlgNotAllowed) {
      return new InvalidAccessTokenError('unsupported_algorithm', options);
    }
    if (error instanceof errors.JOSEError) {
      return new InvalidAccessTokenError('malformed_token', options);
    }
    return error;
  }
}

/**
 * @param claim - The name of the claim `jose` refused.
 * @returns The matching failure reason.
 */
function claimFailureReason(claim: string): 'wrong_issuer' | 'wrong_audience' | 'invalid_claims' {
  if (claim === 'iss') {
    return 'wrong_issuer';
  }
  return claim === 'aud' ? 'wrong_audience' : 'invalid_claims';
}
