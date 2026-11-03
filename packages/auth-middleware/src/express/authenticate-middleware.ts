import { type Logger } from '@ticketnest/logger';
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { type AccessTokenVerifier } from '../access-token-verifier';
import { AUTHORIZATION_HEADER_MAX_LENGTH } from '../access-token-constants';
import { InvalidAccessTokenError } from '../invalid-access-token.error';

import { setAuthenticatedPrincipal } from './authenticated-principal-accessors';

/** `Bearer <token68>`: the scheme is case-insensitive, the token has no spaces (RFC 6750). */
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export interface AuthenticateMiddlewareDependencies {
  readonly verifier: AccessTokenVerifier;
  readonly logger: Logger;
}

/**
 * Builds the middleware that requires a valid access token. It is the only place that knows how
 * the token travels (`Authorization: Bearer`) and which verifier checks it; controllers read the
 * result through `getAuthenticatedPrincipal`.
 *
 * @param dependencies - The verifier and the logger.
 * @returns An Express middleware. On success it stores the caller and calls `next`.
 */
export function createAuthenticateMiddleware(
  dependencies: AuthenticateMiddlewareDependencies,
): RequestHandler {
  const { verifier, logger } = dependencies;
  /**
   * @param request - The incoming request.
   * @param response - Receives the verified caller.
   * @param next - Called once the caller is verified.
   * @throws InvalidAccessTokenError for any missing, malformed or invalid token. The reason goes
   * to the log only.
   * @throws KeySetUnavailableError when the verifier cannot load its keys (answers 503).
   */
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const principal = await verifier.verify(readBearerToken(request));
      setAuthenticatedPrincipal(response, principal);
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) {
        logger.info({ reason: error.reason }, 'access token rejected');
      }
      throw error;
    }
    next();
  };
}

/**
 * Extracts the token from the `Authorization` header.
 *
 * @param request - The incoming request.
 * @returns The token text.
 * @throws InvalidAccessTokenError when the header is missing, too long or not `Bearer <token>`.
 */
function readBearerToken(request: Request): string {
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
