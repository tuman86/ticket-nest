import { type Logger } from '@ticketnest/logger';
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { type AccessTokenVerifier } from '../access-token-verifier';
import { InvalidAccessTokenError } from '../invalid-access-token.error';

import { setAuthenticatedPrincipal } from './authenticated-principal-accessors';
import { readBearerToken } from './read-bearer-token';

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
