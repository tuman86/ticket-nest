import { randomBytes, randomUUID, type KeyObject } from 'node:crypto';

import { ACCESS_TOKEN_ALGORITHM } from '@ticketnest/auth-middleware';
import { SignJWT } from 'jose';

import { hashRefreshToken } from './refresh-token-hash';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_BYTES } from './token-constants';
import {
  type AccessTokenClaims,
  type NewRefreshToken,
  type SignedAccessToken,
  type TokenService,
} from './token-service';

const MILLISECONDS_PER_SECOND = 1000;

export interface EdDsaTokenServiceOptions {
  /** The Ed25519 private key. Only auth-service ever holds it. */
  readonly privateKey: KeyObject;
  /** Put in the `kid` header so verifiers can pick the matching public key. */
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/** `TokenService` that signs access tokens with EdDSA (Ed25519) through `jose`. */
export class EdDsaTokenService implements TokenService {
  private readonly now: () => Date;

  /**
   * @param options - Key, key id, issuer, audience and optional clock.
   * @throws TypeError when `privateKey` is not an Ed25519 private key.
   */
  constructor(private readonly options: EdDsaTokenServiceOptions) {
    if (
      options.privateKey.type !== 'private' ||
      options.privateKey.asymmetricKeyType !== 'ed25519'
    ) {
      throw new TypeError('The signing key must be an Ed25519 private key.');
    }
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Signs an access token valid for `ACCESS_TOKEN_TTL_MS`. Each token gets a random `jti`.
   * `tenantId` is left out entirely for users without a tenant.
   *
   * @param claims - The facts to put in the token.
   * @returns The compact JWT and its lifetime in seconds.
   */
  async signAccessToken(claims: AccessTokenClaims): Promise<SignedAccessToken> {
    const issuedAtSeconds = Math.floor(this.now().getTime() / MILLISECONDS_PER_SECOND);
    const expiresInSeconds = ACCESS_TOKEN_TTL_MS / MILLISECONDS_PER_SECOND;
    const token = await new SignJWT({
      role: claims.roleKey,
      permissions: [...claims.permissions],
      auth_time: Math.floor(claims.authTime.getTime() / MILLISECONDS_PER_SECOND),
      ...(claims.tenantId === null ? {} : { tenantId: claims.tenantId }),
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: this.options.keyId })
      .setSubject(claims.userId)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + expiresInSeconds)
      .sign(this.options.privateKey);
    return { token, expiresInSeconds };
  }

  /**
   * @returns 256 random bits as base64url (43 characters) and the SHA-256 hash of that text.
   */
  createRefreshToken(): NewRefreshToken {
    const value = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return { value, hash: hashRefreshToken(value) };
  }
}
