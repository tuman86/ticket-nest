import { type RequestHandler } from 'express';

import {
  LOGIN_POLICY,
  LOGOUT_POLICY,
  REFRESH_POLICY,
  REGISTER_POLICY,
} from '../rate-limit/rate-limit-policies';
import { createRateLimitMiddleware } from '../rate-limit/rate-limit.middleware';
import { type RateLimitService } from '../rate-limit/rate-limit.service';

/** One rate-limit middleware per public endpoint, ready to mount before its handler. */
export interface AuthRateLimiters {
  readonly register: RequestHandler;
  readonly login: RequestHandler;
  readonly refresh: RequestHandler;
  readonly logout: RequestHandler;
}

export interface AuthRateLimitersOptions {
  readonly rateLimitService: RateLimitService;
}

/**
 * Builds the four limiters with the production policies.
 *
 * @param options - The service that applies the policies.
 * @returns The middleware for register, login, refresh and logout.
 */
export function createAuthRateLimiters(options: AuthRateLimitersOptions): AuthRateLimiters {
  const { rateLimitService } = options;
  return {
    register: createRateLimitMiddleware({ rateLimitService, policy: REGISTER_POLICY }),
    login: createRateLimitMiddleware({ rateLimitService, policy: LOGIN_POLICY }),
    refresh: createRateLimitMiddleware({ rateLimitService, policy: REFRESH_POLICY }),
    logout: createRateLimitMiddleware({ rateLimitService, policy: LOGOUT_POLICY }),
  };
}
