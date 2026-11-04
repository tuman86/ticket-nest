import { type Request } from 'express';

import { AUTHORIZATION_HEADER_MAX_LENGTH } from '../access-token-constants';
import { InvalidAccessTokenError } from '../invalid-access-token.error';

/** `Bearer <token68>`: the scheme is case-insensitive, the token has no spaces (RFC 6750). */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Tells whether the request carries an `Authorization` header at all.
 *
 * @param request - The incoming request.
 * @returns True when the header is present, valid or not.
 */
export function hasAuthorizationHeader(request: Request): boolean {
  return request.headers.authorization !== undefined;
}

/**
 * Extracts the token from the `Authorization` header.
 *
 * @param request - The incoming request.
 * @returns The token text.
 * @throws InvalidAccessTokenError when the header is missing, too long or not `Bearer <token>`.
 */
export function readBearerToken(request: Request): string {
  const header = request.headers.authorization;
  if (header === undefined) {
    throw new InvalidAccessTokenError('missing_header');
  }
  if (header.length > AUTHORIZATION_HEADER_MAX_LENGTH) {
    throw new InvalidAccessTokenError('malformed_header');
  }
  const token = BEARER_PATTERN.exec(header)?.[1];
  if (token === undefined) {
    throw new InvalidAccessTokenError('malformed_header');
  }
  return token;
}
