/**
 * How the gateway treats the access token of a route.
 * - `required`: a valid token, or 401. The default for any route not listed below.
 * - `optional`: no token is fine; a token that is sent must be valid, or 401.
 * - `public`: the token is not read at all.
 */
export type AccessMode = 'required' | 'optional' | 'public';

/** One exception to the default. `path` is written as in the OpenAPI spec (`/v1/movies/{movieId}`). */
export interface AccessRule {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly mode: Exclude<AccessMode, 'required'>;
}

/**
 * The routes that do not need a token. Everything else needs one, so a route missing from this
 * list fails safe. Each entry mirrors an operation whose `security` block in `docs/api/` is `[]`
 * (public) or `[{}, { bearerAuth: [] }]` (optional); `test/unit/routes/access-rules.test.ts`
 * compares the two so they cannot drift. Guest and email-proof tokens are not verified here yet
 * (ADR-0014), so no booking route is listed.
 *
 * Only auth endpoints that auth-service has built and rate limited are listed. The spec also
 * describes email verification, password reset, guest sessions and email OTP, which are not built:
 * until each one has a policy and a middleware in auth-service (CLAUDE.md, Rate limiting), the
 * gateway keeps them on the default `required`, so an anonymous call stops at a 401.
 * `UNBUILT_PUBLIC_AUTH_OPERATIONS` names them so the contract test can account for them.
 */
export const ACCESS_RULES: readonly AccessRule[] = [
  { method: 'POST', path: '/v1/auth/register', mode: 'public' },
  { method: 'POST', path: '/v1/auth/login', mode: 'public' },
  { method: 'POST', path: '/v1/auth/refresh', mode: 'public' },
  { method: 'POST', path: '/v1/auth/logout', mode: 'public' },
  { method: 'GET', path: '/v1/search', mode: 'optional' },
  { method: 'GET', path: '/v1/schedules', mode: 'optional' },
  { method: 'GET', path: '/v1/schedules/{scheduleId}', mode: 'optional' },
  { method: 'GET', path: '/v1/schedules/{scheduleId}/seat-layout', mode: 'optional' },
  { method: 'GET', path: '/v1/movies', mode: 'optional' },
  { method: 'GET', path: '/v1/movies/{movieId}', mode: 'optional' },
  { method: 'GET', path: '/v1/venues', mode: 'optional' },
  { method: 'GET', path: '/v1/venues/{venueId}', mode: 'optional' },
  { method: 'GET', path: '/v1/venues/{venueId}/screens', mode: 'optional' },
  { method: 'GET', path: '/v1/screens/{screenId}', mode: 'optional' },
  { method: 'GET', path: '/v1/stations', mode: 'optional' },
  { method: 'GET', path: '/v1/stations/{stationId}', mode: 'optional' },
  { method: 'GET', path: '/v1/routes', mode: 'optional' },
  { method: 'GET', path: '/v1/routes/{routeId}', mode: 'optional' },
  { method: 'GET', path: '/v1/trains', mode: 'optional' },
  { method: 'GET', path: '/v1/trains/{trainId}', mode: 'optional' },
  { method: 'GET', path: '/v1/cancellation-policies', mode: 'optional' },
  { method: 'GET', path: '/v1/cancellation-policies/{policyId}', mode: 'optional' },
  { method: 'GET', path: '/v1/fee-config', mode: 'optional' },
];

/**
 * Public operations in `docs/api/auth-service.openapi.yaml` that auth-service has not built yet,
 * written as `METHOD path`. They are deliberately missing from `ACCESS_RULES`. Move one into
 * `ACCESS_RULES` in the same change that gives it a rate-limit policy and middleware.
 */
export const UNBUILT_PUBLIC_AUTH_OPERATIONS: readonly string[] = [
  'POST /v1/auth/email-verification/confirm',
  'POST /v1/auth/password-reset',
  'POST /v1/auth/password-reset/confirm',
  'POST /v1/auth/guest-sessions',
  'POST /v1/auth/email-otp',
  'POST /v1/auth/email-otp/verify',
];
