import { z } from 'zod';

import { EMAIL_MAX_LENGTH, Email, PASSWORD_MAX_LENGTH } from './register';

/**
 * Longest raw email accepted before trimming. It is a little above the RFC 5321 limit so
 * harmless padding is tolerated, while an oversized value is rejected before any further work.
 */
export const LOGIN_EMAIL_INPUT_MAX_LENGTH = EMAIL_MAX_LENGTH + 16;

/**
 * Body of `POST /v1/auth/login`. Strict: unknown fields are rejected.
 *
 * The password has a length cap (so a huge value is never hashed) but no minimum beyond one
 * character: the registration policy may have been different when the password was set.
 */
export const LoginRequest = z.strictObject({
  email: z.string().max(LOGIN_EMAIL_INPUT_MAX_LENGTH).trim().pipe(Email),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * The token pair returned by login (and later refresh). A plain object on purpose: parsing a
 * response through it drops any field it does not list.
 */
export const TokenPair = z.object({
  /** JWT. Sent as `Authorization: Bearer <token>`. */
  accessToken: z.string(),
  /** Opaque, single use. The web apps keep it in an httpOnly cookie. */
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Access token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
  /** Seconds until the refresh token expires. */
  refreshExpiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPair>;
