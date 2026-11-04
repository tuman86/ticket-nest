import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import {
  createAuthenticateMiddleware,
  type AuthenticateMiddlewareDependencies,
} from './authenticate-middleware';
import { hasAuthorizationHeader } from './read-bearer-token';

/**
 * Builds the middleware for routes that work without a token but give a signed-in caller more
 * (a catalog read that shows staff extra fields). A request with no `Authorization` header goes
 * through as anonymous. A request that sends one is held to the same rules as a required token:
 * an invalid or expired token answers 401, never a silent downgrade to anonymous, so the client
 * refreshes its token instead of showing a signed-in user the public view.
 *
 * @param dependencies - The verifier and the logger.
 * @returns An Express middleware. Handlers read the caller with `findAuthenticatedPrincipal`.
 */
export function createOptionalAuthenticateMiddleware(
  dependencies: AuthenticateMiddlewareDependencies,
): RequestHandler {
  const authenticate = createAuthenticateMiddleware(dependencies);
  /**
   * @param request - The incoming request.
   * @param response - Receives the verified caller, when there is one.
   * @param next - Called for an anonymous request, or once the caller is verified.
   * @throws InvalidAccessTokenError for a token that is present but not valid.
   * @throws KeySetUnavailableError when the verifier cannot load its keys (answers 503).
   */
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!hasAuthorizationHeader(request)) {
      next();
      return;
    }
    await authenticate(request, response, next);
  };
}
