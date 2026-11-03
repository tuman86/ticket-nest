import { createHash } from 'node:crypto';

/**
 * Hashes a refresh token the way it is stored: SHA-256, lower-case hex. A plain fast hash is
 * enough here because the token is 256 random bits, not a human-chosen secret.
 *
 * @param refreshToken - The opaque token value.
 * @returns 64 lower-case hex characters, safe to store and to look up by.
 */
export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}
