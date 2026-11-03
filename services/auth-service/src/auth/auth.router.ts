import { Router } from 'express';

import { type AuthRateLimiters } from './auth-rate-limiters';
import { createLoginHandler } from './login.controller';
import { type LoginService } from './login.service';
import { createLogoutHandler } from './logout.controller';
import { type LogoutService } from './logout.service';
import { createRefreshHandler } from './refresh.controller';
import { type RefreshService } from './refresh.service';
import { createRegisterHandler } from './register.controller';
import { type RegisterService } from './register.service';

export interface AuthRouterDependencies {
  /** Rate-limit middleware, mounted before each handler. */
  readonly rateLimiters: AuthRateLimiters;
  readonly registerService: RegisterService;
  readonly loginService: LoginService;
  readonly refreshService: RefreshService;
  readonly logoutService: LogoutService;
}

/**
 * Mounts the public authentication endpoints, each behind its rate limiter. More are added here as
 * they are built.
 *
 * @param dependencies - The services the handlers call.
 * @returns A router to pass to `createApp` through `routers`.
 */
export function createAuthRouter(dependencies: AuthRouterDependencies): Router {
  const router = Router();
  const { rateLimiters } = dependencies;
  router.post(
    '/v1/auth/register',
    rateLimiters.register,
    createRegisterHandler(dependencies.registerService),
  );
  router.post('/v1/auth/login', rateLimiters.login, createLoginHandler(dependencies.loginService));
  router.post(
    '/v1/auth/refresh',
    rateLimiters.refresh,
    createRefreshHandler(dependencies.refreshService),
  );
  router.post(
    '/v1/auth/logout',
    rateLimiters.logout,
    createLogoutHandler(dependencies.logoutService),
  );
  return router;
}
