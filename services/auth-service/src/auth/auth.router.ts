import { Router } from 'express';

import { createRegisterHandler } from './register.controller';
import { type RegisterService } from './register.service';

export interface AuthRouterDependencies {
  readonly registerService: RegisterService;
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
  return router;
}
