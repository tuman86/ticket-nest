/** What goes into an access token. */
export interface AccessTokenClaims {
  readonly userId: string;
  /** The role's key, for example `CUSTOMER`. */
  readonly roleKey: string;
  /** Permission keys copied from the role (`resource:action[:scope]`). */
  readonly permissions: readonly string[];
  /** Set only for operator users. */
  readonly tenantId: string | null;
  /** When the user last entered their password. A refresh copies it unchanged. */
  readonly authTime: Date;
}

export interface SignedAccessToken {
  /** The compact JWT. */
  readonly token: string;
  /** Lifetime in seconds, as reported to clients. */
  readonly expiresInSeconds: number;
}

export interface NewRefreshToken {
  /** The opaque value handed to the client once. Never stored or logged. */
  readonly value: string;
  /** SHA-256 of `value`, lower-case hex. The only form that is stored. */
  readonly hash: string;
}

/** Creates the credentials a login hands out. Services depend on this, not on a JWT library. */
export interface TokenService {
  /**
   * Signs a short-lived access token.
   *
   * @param claims - The facts to put in the token.
   * @returns The compact JWT and its lifetime.
   */
  signAccessToken(claims: AccessTokenClaims): Promise<SignedAccessToken>;

  /**
   * Generates a new opaque refresh token from a cryptographically secure source.
   *
   * @returns The value for the client and the hash to store.
   */
  createRefreshToken(): NewRefreshToken;
}
