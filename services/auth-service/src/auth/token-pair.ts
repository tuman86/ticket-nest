import { type TokenPair } from '@ticketnest/contracts';

import { REFRESH_ABSOLUTE_TTL_MS, REFRESH_IDLE_TTL_MS } from './token-constants';
import { type SignedAccessToken } from './token-service';

const MILLISECONDS_PER_SECOND = 1000;
const MIN_REFRESH_EXPIRES_IN_SECONDS = 1;

/**
 * When a refresh token issued now expires: 7 days idle, but never later than 30 days after the
 * password login. Because every token of a session carries the same `authTime`, a chain of
 * refreshes cannot extend a session past that limit.
 *
 * @param authTime - When the user last entered their password (copied unchanged along the chain).
 * @param now - The current time.
 * @returns The expiry for the token being issued.
 */
export function calculateRefreshExpiry(authTime: Date, now: Date): Date {
  const idleExpiry = now.getTime() + REFRESH_IDLE_TTL_MS;
  const sessionLimit = authTime.getTime() + REFRESH_ABSOLUTE_TTL_MS;
  return new Date(Math.min(idleExpiry, sessionLimit));
}

/**
 * @param authTime - When the user last entered their password.
 * @param now - The current time.
 * @returns True once the session is 30 days old, whatever the token's own expiry says.
 */
export function hasSessionEnded(authTime: Date, now: Date): boolean {
  return now.getTime() >= authTime.getTime() + REFRESH_ABSOLUTE_TTL_MS;
}

/**
 * Builds the response body defined by the OpenAPI `TokenPair` schema, shared by login and refresh.
 *
 * @param accessToken - The signed access token.
 * @param refreshTokenValue - The opaque refresh token value, shown to the client once.
 * @param refreshExpiresAt - When that refresh token expires.
 * @param now - The current time.
 * @returns The token pair. `refreshExpiresIn` is the whole seconds left, at least 1.
 */
export function toTokenPair(
  accessToken: SignedAccessToken,
  refreshTokenValue: string,
  refreshExpiresAt: Date,
  now: Date,
): TokenPair {
  const secondsLeft = Math.floor(
    (refreshExpiresAt.getTime() - now.getTime()) / MILLISECONDS_PER_SECOND,
  );
  return {
    accessToken: accessToken.token,
    refreshToken: refreshTokenValue,
    tokenType: 'Bearer',
    expiresIn: accessToken.expiresInSeconds,
    refreshExpiresIn: Math.max(MIN_REFRESH_EXPIRES_IN_SECONDS, secondsLeft),
  };
}
