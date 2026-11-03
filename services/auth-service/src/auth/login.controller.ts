import { LoginRequest, TokenPair } from '@ticketnest/contracts';
import { fromZodError } from '@ticketnest/errors';
import { type Request, type RequestHandler, type Response } from 'express';

import { readClientDetails } from './client-details';
import { type LoginService } from './login.service';

const OK_STATUS = 200;

/**
 * Builds the handler for `POST /v1/auth/login`. It only parses the body, makes one service call
 * and maps the result; the business rules live in `LoginService`.
 *
 * @param loginService - The service that checks credentials and starts the session.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createLoginHandler(loginService: LoginService): RequestHandler {
  /**
   * @param request - The incoming request. Its body is untrusted until parsed here.
   * @param response - Answered with 200 and the `TokenPair`, marked `no-store`.
   * @throws ValidationError when the body does not match `LoginRequest`.
   */
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = LoginRequest.safeParse(request.body);
    if (!parsed.success) {
      throw fromZodError(parsed.error, 'body');
    }
    const tokenPair = await loginService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ...readClientDetails(request),
    });
    // Responses that carry tokens must never be cached by a browser or a proxy.
    response.status(OK_STATUS).set('Cache-Control', 'no-store').json(TokenPair.parse(tokenPair));
  };
}
