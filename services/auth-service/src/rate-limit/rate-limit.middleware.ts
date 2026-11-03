import { type Request, type RequestHandler } from 'express';

import { readRateLimitIdentifiers } from './rate-limit-identifiers';
import { type RateLimitPolicy } from './rate-limit-policies';
import { type RateLimitService } from './rate-limit.service';

export interface RateLimitMiddlewareOptions {
  readonly rateLimitService: RateLimitService;
  /** The endpoint's rules. */
  readonly policy: RateLimitPolicy;
}

/**
 * Builds the middleware that rate limits one endpoint. It only reads what the request can be
 * counted by and makes one service call; the rules live in the policy and the service. Mount it
 * after the JSON body parser and before the endpoint's handler.
 *
 * @param options - The service and the policy of the endpoint.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): RequestHandler {
  /**
   * Counts the request against the policy and passes it on when it is under every limit.
   *
   * @param request - The incoming request, after the JSON body parser.
   * @param _response - Unused: a refusal is thrown, not written here.
   * @param next - Called when the request may continue to the endpoint's handler.
   * @throws TooManyRequestsError when the request is over a limit.
   * @throws ServiceUnavailableError when the limiter is down and the policy fails closed.
   */
  return async (request: Request, _response, next): Promise<void> => {
    await options.rateLimitService.check(options.policy, readRateLimitIdentifiers(request));
    next();
  };
}
