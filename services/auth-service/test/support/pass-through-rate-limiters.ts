import { type RequestHandler } from 'express';

import { type AuthRateLimiters } from '@/auth/auth-rate-limiters';

/**
 * Builds limiter middleware that lets every request through, for tests of other behaviour where
 * a limit would only get in the way.
 *
 * @returns Four handlers that call `next()` and nothing else.
 */
export function createPassThroughRateLimiters(): AuthRateLimiters {
  /**
   * Hands the request straight on.
   *
   * @param _request - Unused.
   * @param _response - Unused.
   * @param next - Called at once to continue to the endpoint's handler.
   */
  const passThrough: RequestHandler = (_request, _response, next) => {
    next();
  };
  return { register: passThrough, login: passThrough, refresh: passThrough, logout: passThrough };
}
