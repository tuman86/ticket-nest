import { type CorsOptions } from 'cors';

/**
 * Response headers a browser app may read. A cross-origin page sees none of these unless they are
 * listed: `ETag` for `If-Match`, `Retry-After` and `RateLimit-*` for backing off, `Location` for
 * created resources and `X-Request-Id` for support requests (docs/api/common.yaml).
 */
export const EXPOSED_RESPONSE_HEADERS = [
  'ETag',
  'Location',
  'Retry-After',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'X-Request-Id',
] as const;

/** How long a browser may cache a preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Builds the CORS settings for the browser apps. Only the listed origins are allowed. Credentials
 * (cookies) are not: the apps send the access token in the `Authorization` header, and the refresh
 * cookie never leaves their own server-side route handlers (ADR-0013). The headers a browser may
 * send are not restricted here; `cors` echoes what the preflight asks for.
 *
 * @param allowedOrigins - The `web` and `console` origins. Empty denies every origin.
 * @returns Options for the `cors` middleware.
 */
export function createCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    origin: [...allowedOrigins],
    exposedHeaders: [...EXPOSED_RESPONSE_HEADERS],
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
}
