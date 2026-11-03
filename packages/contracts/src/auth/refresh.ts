import { z } from 'zod';

/**
 * Longest refresh token accepted. A real token is 43 characters (256 random bits as base64url),
 * so this leaves room without letting a large value reach the database lookup.
 */
export const REFRESH_TOKEN_MAX_LENGTH = 128;

/** Body of `POST /v1/auth/refresh` (and later logout). Strict: unknown fields are rejected. */
export const RefreshRequest = z.strictObject({
  refreshToken: z.string().min(1).max(REFRESH_TOKEN_MAX_LENGTH),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;
