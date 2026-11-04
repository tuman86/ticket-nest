import { Router, type RequestHandler } from 'express';

import { createRequestBodyLimit } from '../http/request-body-limit.middleware';
import { handleRouteResolution } from '../routes/resolve-route.middleware';

export interface ProxyRouterDependencies {
  /** Counts by client IP. Runs first, before the token is looked at. */
  readonly limitByIp: RequestHandler;
  /** Authenticates the way the resolved route says. */
  readonly authenticate: RequestHandler;
  /** Counts by signed-in user. Runs after authentication. */
  readonly limitByUser: RequestHandler;
  readonly forward: RequestHandler;
  readonly maxRequestBodyBytes: number;
}

/**
 * Builds the router that carries every request to a service. The order is the design: the cheap
 * IP limit and the body limit first, then the route lookup (unknown paths stop here with 404),
 * then the token, then the per-user limit, then the forward.
 *
 * @param dependencies - The steps, built in the composition root.
 * @returns A router to mount after the health endpoints and CORS.
 */
export function createProxyRouter(dependencies: ProxyRouterDependencies): Router {
  const router = Router();
  router.use(
    dependencies.limitByIp,
    createRequestBodyLimit(dependencies.maxRequestBodyBytes),
    handleRouteResolution,
    dependencies.authenticate,
    dependencies.limitByUser,
    dependencies.forward,
  );
  return router;
}
