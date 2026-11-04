import { type AccessTokenVerifier } from '@ticketnest/auth-middleware';
import {
  createAuthenticateMiddleware,
  createOptionalAuthenticateMiddleware,
} from '@ticketnest/auth-middleware/express';
import { type Logger } from '@ticketnest/logger';
import { type RequestHandler } from 'express';

import { getResolvedRoute } from '../routes/route-context';

export interface AuthenticateByModeDependencies {
  readonly verifier: AccessTokenVerifier;
  readonly logger: Logger;
}

/**
 * Builds the middleware that authenticates a request the way its route says: a `public` route
 * never reads the token, an `optional` route verifies one if it is sent, and a `required` route
 * needs a valid one. It must run after route resolution.
 *
 * @param dependencies - The verifier and the logger.
 * @returns An Express middleware. A refused token reaches the shared error handler as a 401.
 */
export function createAuthenticateByMode(
  dependencies: AuthenticateByModeDependencies,
): RequestHandler {
  const required = createAuthenticateMiddleware(dependencies);
  const optional = createOptionalAuthenticateMiddleware(dependencies);
  /**
   * @param request - The incoming request.
   * @param response - Carries the resolved route, which holds the access mode.
   * @param next - Called once the token is accepted, or at once on a public route.
   */
  return (request, response, next) => {
    const { accessMode } = getResolvedRoute(response);
    if (accessMode === 'public') {
      next();
      return;
    }
    return (accessMode === 'optional' ? optional : required)(request, response, next);
  };
}
