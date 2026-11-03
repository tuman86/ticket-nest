import { RegisterRequest } from '@ticketnest/contracts';
import { fromZodError } from '@ticketnest/errors';
import { type Request, type RequestHandler, type Response } from 'express';

import { toUserResponse } from '../users/to-user-response';

import { type RegisterService } from './register.service';

const CREATED_STATUS = 201;

/**
 * Builds the handler for `POST /v1/auth/register`. It only parses the body, makes one service
 * call and maps the result; the business rules live in `RegisterService`.
 *
 * @param registerService - The service that creates the account.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createRegisterHandler(registerService: RegisterService): RequestHandler {
  /**
   * @param request - The incoming request. Its body is untrusted until parsed here.
   * @param response - Answered with 201, a `Location` header and the `User`.
   * @throws ValidationError when the body does not match `RegisterRequest`.
   */
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = RegisterRequest.safeParse(request.body);
    if (!parsed.success) {
      throw fromZodError(parsed.error, 'body');
    }
    const { user, role } = await registerService.registerCustomer(parsed.data);
    response
      .status(CREATED_STATUS)
      .location(`/v1/users/${user.id}`)
      .json(toUserResponse(user, role));
  };
}
