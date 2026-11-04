import { type Request, type RequestHandler, type Response } from 'express';

import { type RateLimitIdentifiers, type RateLimitPolicy } from '../rate-limit-policy';
import { type RateLimitService } from '../rate-limit.service';

export interface RateLimitMiddlewareOptions {
  readonly rateLimitService: RateLimitService;
  /** The rules to apply. */
  readonly policy: RateLimitPolicy;
  /**
   * Reads what this policy counts by from the request (the client IP, the user id, an email in
   * the body...). It runs before the endpoint validates anything, so it must treat every value as
   * untrusted and return only the scopes it can find.
   */
  readonly readIdentifiers: (request: Request, response: Response) => RateLimitIdentifiers;
}

/**
 * Builds the middleware that rate limits one endpoint or one layer. It only reads what the
 * request can be counted by and makes one service call; the rules live in the policy and the
 * service. Mount it after whatever `readIdentifiers` depends on (the JSON body parser, the
 * authentication middleware) and before the handler.
 *
 * @param options - The service, the policy and the identifier reader.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  /**
   * Counts the request against the policy and passes it on when it is under every limit.
   *
   * @param request - The incoming request.
   * @param response - The response, which `readIdentifiers` may read `response.locals` from.
   * @param next - Called when the request may continue to the handler.
   * @throws TooManyRequestsError when the request is over a limit.
   * @throws ServiceUnavailableError when the limiter is down and the policy fails closed.
   */
  return async (request, response, next): Promise<void> => {
    await options.rateLimitService.check(
      options.policy,
      options.readIdentifiers(request, response),
    );
    next();
  };
}
