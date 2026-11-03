import { RefreshRequest, TokenPair } from '@ticketnest/contracts';
import { fromZodError } from '@ticketnest/errors';
import { type Request, type RequestHandler, type Response } from 'express';

import { readClientDetails } from './client-details';
import { type RefreshService } from './refresh.service';

const OK_STATUS = 200;

/**
 * Builds the handler for `POST /v1/auth/refresh`. It only parses the body, makes one service call
 * and maps the result; the business rules live in `RefreshService`.
 *
 * @param refreshService - The service that rotates the refresh token.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createRefreshHandler(refreshService: RefreshService): RequestHandler {
  /**
   * @param request - The incoming request. Its body is untrusted until parsed here.
   * @param response - Answered with 200 and the `TokenPair`, marked `no-store`.
   * @throws ValidationError when the body does not match `RefreshRequest`.
   */
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = RefreshRequest.safeParse(request.body);
    if (!parsed.success) {
      throw fromZodError(parsed.error, 'body');
    }
    const tokenPair = await refreshService.refresh({
      refreshToken: parsed.data.refreshToken,
      ...readClientDetails(request),
    });
    // Responses that carry tokens must never be cached by a browser or a proxy.
    response.status(OK_STATUS).set('Cache-Control', 'no-store').json(TokenPair.parse(tokenPair));
  };
}
