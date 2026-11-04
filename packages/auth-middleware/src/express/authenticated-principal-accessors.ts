import { InternalServerError } from '@ticketnest/errors';
import { type Response } from 'express';

import { type AuthenticatedPrincipal } from '../authenticated-principal';

const PRINCIPAL_LOCALS_KEY = 'authenticatedPrincipal';

/**
 * Remembers who the request is from, for the handlers after the authentication middleware.
 *
 * @param response - The response of the current request.
 * @param principal - The verified caller.
 */
export function setAuthenticatedPrincipal(
  response: Response,
  principal: AuthenticatedPrincipal,
): void {
  response.locals[PRINCIPAL_LOCALS_KEY] = principal;
}

/**
 * Reads who the request is from, for a route that also serves anonymous callers.
 *
 * @param response - The response of the current request.
 * @returns The verified caller, or `undefined` when the request was anonymous.
 */
export function findAuthenticatedPrincipal(response: Response): AuthenticatedPrincipal | undefined {
  return response.locals[PRINCIPAL_LOCALS_KEY] as AuthenticatedPrincipal | undefined;
}

/**
 * Reads who the request is from. The only thing a controller needs from authentication, so the
 * verifier behind the middleware can be replaced without touching controllers.
 *
 * @param response - The response of the current request.
 * @returns The verified caller.
 * @throws InternalServerError when no authentication middleware ran before this handler.
 */
export function getAuthenticatedPrincipal(response: Response): AuthenticatedPrincipal {
  const principal = response.locals[PRINCIPAL_LOCALS_KEY] as AuthenticatedPrincipal | undefined;
  if (principal === undefined) {
    throw new InternalServerError({
      detail: 'The route is missing its authentication middleware.',
    });
  }
  return principal;
}
