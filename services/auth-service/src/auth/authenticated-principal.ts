import { InternalServerError } from '@ticketnest/errors';
import { type Response } from 'express';

/**
 * The caller, as proven by a verified access token. Claims are what the token said when it was
 * issued, so handlers must not return them: load the current data from the database by `userId`.
 */
export interface AuthenticatedPrincipal {
  /** The token's `sub`: the user's id. */
  readonly userId: string;
  /** The role key at issue time (for example `CUSTOMER`). */
  readonly roleKey: string;
  /** Permission keys at issue time. */
  readonly permissions: readonly string[];
  /** Set only for operator users. */
  readonly tenantId: string | null;
  /** When the user last entered their password. */
  readonly authTime: Date;
  /** The token's `jti`. */
  readonly tokenId: string;
}

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
