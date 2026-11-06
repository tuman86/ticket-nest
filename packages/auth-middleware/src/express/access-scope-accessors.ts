import { InternalServerError } from '@ticketnest/errors';
import { type Response } from 'express';

import { type AccessScope } from '../access-scope';

const SCOPE_LOCALS_KEY = 'accessScope';

/**
 * Remembers how far the caller's access reaches, for the handlers after the access guard. Only the
 * guard calls it, so a scope in `response.locals` always comes from a decision it made.
 *
 * @param response - The response of the current request.
 * @param scope - The scope the guard resolved from the token.
 */
export function setAccessScope(response: Response, scope: AccessScope): void {
  response.locals[SCOPE_LOCALS_KEY] = scope;
}

/**
 * Reads the scope the access guard resolved. It never falls back to a default, so a handler that
 * the guard does not protect cannot silently run with unrestricted access.
 *
 * @param response - The response of the current request.
 * @returns The scope the handler must stay within.
 * @throws InternalServerError when no access guard ran before this handler.
 */
export function getAccessScope(response: Response): AccessScope {
  const scope = response.locals[SCOPE_LOCALS_KEY] as AccessScope | undefined;
  if (scope === undefined) {
    throw new InternalServerError({ detail: 'The route is missing its access guard.' });
  }
  return scope;
}
