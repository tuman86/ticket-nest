import { type KeyObject } from 'node:crypto';

import { Id } from '@ticketnest/contracts';
import { decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { z } from 'zod';

import { type AccessTokenVerifier } from './access-token-verifier';
import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_CLOCK_TOLERANCE_MS } from './access-token-constants';
import { type AuthenticatedPrincipal } from './authenticated-principal';
import { InvalidAccessTokenError } from './invalid-access-token.error';
import { type KeyResolver } from './key-resolver';

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

export interface JwtAccessTokenVerifierOptions {
  /** Where the public key a token's `kid` names comes from. */
  readonly keyResolver: KeyResolver;
  readonly issuer: string;
  readonly audience: string;
  /**
   * Drift allowed past `exp`, in milliseconds. Defaults to `ACCESS_TOKEN_CLOCK_TOLERANCE_MS`.
   * Pass 0 only for a verifier that runs on the signer's own clock.
   */
  readonly clockToleranceMs?: number;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/**
 * Verifies EdDSA access tokens for every service and the gateway, built on `jose`. It accepts only
 * `EdDSA`, a `kid` its key resolver knows, and the configured issuer and audience (ADR-0013). The
 * key source is behind `KeyResolver`, so the same verifier serves auth-service (keys in memory)
 * and every other service (keys from the JWKS endpoint).
 */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly now: () => Date;
  private readonly clockToleranceSeconds: number;

  /**
   * @param options - Key resolver, issuer, audience and optional tolerance and clock.
   */
  constructor(private readonly options: JwtAccessTokenVerifierOptions) {
    this.now = options.now ?? (() => new Date());
    this.clockToleranceSeconds =
      (options.clockToleranceMs ?? ACCESS_TOKEN_CLOCK_TOLERANCE_MS) / MILLISECONDS_PER_SECOND;
  }

  /**
   * Verifies algorithm, key id, signature, `iss`, `aud` and `exp`, then the shape of the claims.
   *
   * @param token - The compact JWT.
   * @returns The caller the token names.
   * @throws InvalidAccessTokenError for every invalid token.
   * @throws KeySetUnavailableError when the key resolver cannot load the keys.
   */
  async verify(token: string): Promise<AuthenticatedPrincipal> {
    const verificationKey = await this.selectVerificationKey(token);
    try {
      const { payload } = await jwtVerify(token, verificationKey, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.options.issuer,
        audience: this.options.audience,
        requiredClaims: REQUIRED_CLAIMS,
        clockTolerance: this.clockToleranceSeconds,
        currentDate: this.now(),
      });
      return this.toPrincipal(payload);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Refuses a token whose header names another algorithm or an unknown key before any signature
   * work, so `none`, HMAC and RSA tokens never reach the verifier and never cost a key lookup,
   * then asks the resolver for the key the `kid` names.
   *
   * @param token - The compact JWT.
   * @returns The public key to verify the signature with.
   * @throws InvalidAccessTokenError when the header is unreadable, or names another `alg` or an unknown `kid`.
   * @throws KeySetUnavailableError when the resolver cannot load the keys.
   */
  private async selectVerificationKey(token: string): Promise<KeyObject> {
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch (error) {
      throw new InvalidAccessTokenError('malformed_token', { cause: error });
    }
    if (header.alg !== ACCESS_TOKEN_ALGORITHM) {
      throw new InvalidAccessTokenError('unsupported_algorithm');
    }
    const verificationKey =
      typeof header.kid === 'string'
        ? await this.options.keyResolver.resolveKey(header.kid)
        : undefined;
    if (verificationKey === undefined) {
      throw new InvalidAccessTokenError('unknown_key_id');
    }
    return verificationKey;
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
