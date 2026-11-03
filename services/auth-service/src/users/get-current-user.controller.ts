import { type RequestHandler, type Request, type Response } from 'express';

import { getAuthenticatedPrincipal } from '../auth/authenticated-principal';

import { type GetCurrentUserService } from './get-current-user.service';

const OK_STATUS = 200;

/**
 * Builds the handler for `GET /v1/users/me`. It reads who the caller is from the authentication
 * middleware, makes one service call and maps the result. Run it after the middleware.
 *
 * @param getCurrentUserService - The service that loads the caller's profile.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createGetCurrentUserHandler(
  getCurrentUserService: GetCurrentUserService,
): RequestHandler {
  /**
   * @param _request - Unused: the caller comes from the middleware.
   * @param response - Answered with 200 and the `User`, marked `no-store`.
   */
  return async (_request: Request, response: Response): Promise<void> => {
    const { userId } = getAuthenticatedPrincipal(response);
    const user = await getCurrentUserService.getCurrentUser(userId);
    // The response is personal data: it must never be cached by a browser or a proxy.
    response.status(OK_STATUS).set('Cache-Control', 'no-store').json(user);
  };
}
