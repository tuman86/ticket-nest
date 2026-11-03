import { UnauthorizedError } from '@ticketnest/errors';

const INVALID_REFRESH_TOKEN_CODE = 'INVALID_REFRESH_TOKEN';
const INVALID_REFRESH_TOKEN_PROBLEM_TYPE = 'invalid-refresh-token';

/** The one message every failed refresh carries. It never says why the token was refused. */
export const INVALID_REFRESH_TOKEN_DETAIL = 'Invalid refresh token.';

/**
 * 401: the refresh token is unknown, expired, revoked, already used, past the session limit, or
 * its user is no longer active.
 *
 * All of those look the same to the caller. Telling a thief "this token was replayed" would only
 * help them, and the client reaction is the same in every case: sign in again. The reason goes to
 * the server log. Code, type and detail are fixed here and cannot be overridden.
 */
export class InvalidRefreshTokenError extends UnauthorizedError {
  constructor() {
    super({
      code: INVALID_REFRESH_TOKEN_CODE,
      problemType: INVALID_REFRESH_TOKEN_PROBLEM_TYPE,
      detail: INVALID_REFRESH_TOKEN_DETAIL,
    });
  }
}
