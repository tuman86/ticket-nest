import { Router } from 'express';

import { createLoginHandler } from './login.controller';
import { type LoginService } from './login.service';
import { createRegisterHandler } from './register.controller';
import { type RegisterService } from './register.service';

export interface AuthRouterDependencies {
  readonly registerService: RegisterService;
  readonly loginService: LoginService;
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
  return router;
}
