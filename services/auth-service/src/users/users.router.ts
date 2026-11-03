import { Router, type RequestHandler } from 'express';

import { createGetCurrentUserHandler } from './get-current-user.controller';
import { type GetCurrentUserService } from './get-current-user.service';

export interface UsersRouterDependencies {
  /** Requires a valid access token and stores the caller. The shared package will provide it. */
  readonly authenticate: RequestHandler;
  readonly getCurrentUserService: GetCurrentUserService;
}

/**
 * Mounts the endpoints about the signed-in user. Not exposed through the gateway yet.
 *
 * @param dependencies - The authentication middleware and the services the handlers call.
 * @returns A router to pass to `createApp` through `routers`.
 */
export function createUsersRouter(dependencies: UsersRouterDependencies): Router {
  const router = Router();
  router.get(
    '/v1/users/me',
    dependencies.authenticate,
    createGetCurrentUserHandler(dependencies.getCurrentUserService),
  );
  return router;
}
