import { findAuthenticatedPrincipal } from '@ticketnest/auth-middleware/express';
import {
  IP_SCOPE,
  USER_SCOPE,
  readClientIp,
  type RateLimitPolicy,
  type RateLimitService,
} from '@ticketnest/rate-limit';
import { createRateLimitMiddleware } from '@ticketnest/rate-limit/express';
import { type RequestHandler } from 'express';

import { GATEWAY_IP_POLICY, GATEWAY_USER_POLICY } from './gateway-rate-limit-policies';

export interface GatewayRateLimitersOptions {
  readonly rateLimitService: RateLimitService;
  /** Replaceable so a test can use a small limit. Defaults to the production policy. */
  readonly ipPolicy?: RateLimitPolicy;
  readonly userPolicy?: RateLimitPolicy;
}

export interface GatewayRateLimiters {
  /** Counts by client IP. Mount it first, before the token is looked at. */
  readonly byIp: RequestHandler;
  /** Counts by signed-in user. A request with no verified caller is skipped. Mount it after authentication. */
  readonly byUser: RequestHandler;
}

/**
 * Builds the gateway's two rate-limit middlewares.
 *
 * @param options - The service that applies the policies, and optional replacement policies.
 * @returns The IP limiter and the user limiter.
 */
export function createGatewayRateLimiters(
  options: GatewayRateLimitersOptions,
): GatewayRateLimiters {
  const { rateLimitService } = options;
  return {
    byIp: createRateLimitMiddleware({
      rateLimitService,
      policy: options.ipPolicy ?? GATEWAY_IP_POLICY,
      readIdentifiers: (request) => ({ [IP_SCOPE]: readClientIp(request.ip) }),
    }),
    byUser: createRateLimitMiddleware({
      rateLimitService,
      policy: options.userPolicy ?? GATEWAY_USER_POLICY,
      readIdentifiers: (_request, response) => {
        const principal = findAuthenticatedPrincipal(response);
        return principal === undefined ? {} : { [USER_SCOPE]: principal.userId };
      },
    }),
  };
}
