import { RefreshRequest } from '@ticketnest/contracts';
import { fromZodError } from '@ticketnest/errors';
import { type Request, type RequestHandler, type Response } from 'express';

import { type LogoutService } from './logout.service';

const NO_CONTENT_STATUS = 204;

/**
 * Builds the handler for `POST /v1/auth/logout`. It only parses the body, makes one service call
 * and answers 204; the business rules live in `LogoutService`. The body is the same as refresh's.
 *
 * @param logoutService - The service that revokes the session.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createLogoutHandler(logoutService: LogoutService): RequestHandler {
  /**
   * @param request - The incoming request. Its body is untrusted until parsed here.
   * @param response - Answered with an empty 204 whatever the token was.
   * @throws ValidationError when the body does not match `RefreshRequest`.
   */
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = RefreshRequest.safeParse(request.body);
    if (!parsed.success) {
      throw fromZodError(parsed.error, 'body');
    }
    await logoutService.logout({ refreshToken: parsed.data.refreshToken });
    response.status(NO_CONTENT_STATUS).end();
  };
}
