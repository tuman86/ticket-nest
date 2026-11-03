import { UnauthorizedError } from '@ticketnest/errors';

/** The one message every rejected access token carries. It never says why the token was refused. */
export const INVALID_ACCESS_TOKEN_DETAIL = 'Missing, expired, or invalid access token.';

/** Why an access token was refused. For the server log only; never sent to the caller. */
export type AccessTokenFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'unknown_key_id'
  | 'bad_signature'
  | 'expired'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'invalid_claims'
  | 'user_inactive';

/**
 * 401: the request has no usable access token. A missing header, a bad signature, an expired or
 * tampered token, a wrong issuer or audience, an unknown key and a user who is gone or disabled
 * all answer the same status, code, type, challenge and detail, so a caller learns nothing about
 * which check failed. The reason is kept on the error for the log.
 */
export class InvalidAccessTokenError extends UnauthorizedError {
  /**
   * @param reason - Why the token was refused. Logged internally, never in the response.
   * @param options - Optional cause, for example the library error behind the refusal.
   */
  constructor(
    readonly reason: AccessTokenFailureReason,
    options: { readonly cause?: unknown } = {},
  ) {
    super({ detail: INVALID_ACCESS_TOKEN_DETAIL, ...options });
  }
}
