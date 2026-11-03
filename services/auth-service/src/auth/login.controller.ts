import { LoginRequest, TokenPair } from '@ticketnest/contracts';
import { fromZodError } from '@ticketnest/errors';
import { type Request, type RequestHandler, type Response } from 'express';

import { IP_MAX_LENGTH, USER_AGENT_MAX_LENGTH } from './token-constants';
import { type LoginService } from './login.service';

const OK_STATUS = 200;

/**
 * @param value - A client-supplied string, or undefined when absent.
 * @param maxLength - The longest value the database column holds.
 * @returns The value cut to `maxLength`, or null when absent or empty.
 */
function truncateOrNull(value: string | undefined, maxLength: number): string | null {
  if (value === undefined || value === '') {
    return null;
  }
  return value.slice(0, maxLength);
}

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
      userAgent: truncateOrNull(request.get('user-agent'), USER_AGENT_MAX_LENGTH),
      ip: truncateOrNull(request.ip, IP_MAX_LENGTH),
    });
    // Responses that carry tokens must never be cached by a browser or a proxy.
    response.status(OK_STATUS).set('Cache-Control', 'no-store').json(TokenPair.parse(tokenPair));
  };
}
