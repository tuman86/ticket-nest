import { Router } from 'express';

import { createLoginHandler } from './login.controller';
import { type LoginService } from './login.service';
import { createLogoutHandler } from './logout.controller';
import { type LogoutService } from './logout.service';
import { createRefreshHandler } from './refresh.controller';
import { type RefreshService } from './refresh.service';
import { createRegisterHandler } from './register.controller';
import { type RegisterService } from './register.service';

export interface AuthRouterDependencies {
  readonly registerService: RegisterService;
  readonly loginService: LoginService;
  readonly refreshService: RefreshService;
  readonly logoutService: LogoutService;
}

/**
 * Mounts the public authentication endpoints. More are added here as they are built.
 *
 * @param dependencies - The services the handlers call.
 * @returns A router to pass to `createApp` through `routers`.
 */
export function createAuthRouter(dependencies: AuthRouterDependencies): Router {
  const router = Router();
  router.post('/v1/auth/register', createRegisterHandler(dependencies.registerService));
  // The login rate limiter (feat/auth-rate-limit) plugs in here, as middleware before the handler:
  // `router.post('/v1/auth/login', loginRateLimiter, handler)`. Until it lands this route must not
  // be exposed through the gateway.
  router.post('/v1/auth/login', createLoginHandler(dependencies.loginService));
  // The refresh rate limiter (feat/auth-rate-limit) plugs in here the same way, keyed by IP and by
  // a hash of the presented token. Until it lands this route must not be exposed through the
  // gateway either.
  router.post('/v1/auth/refresh', createRefreshHandler(dependencies.refreshService));
  // The logout rate limiter (feat/auth-rate-limit) plugs in here the same way, keyed by IP. Logout
  // answers 204 whatever the token was, so it is no enumeration oracle, but it is a database
  // write: it gets a limiter before it is exposed through the gateway.
  router.post('/v1/auth/logout', createLogoutHandler(dependencies.logoutService));
  return router;
}
