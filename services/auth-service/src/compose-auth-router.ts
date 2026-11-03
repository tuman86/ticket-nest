import { randomBytes } from 'node:crypto';

import { type Logger } from '@ticketnest/logger';
import { type Router } from 'express';
import { type Pool } from 'pg';

import { Argon2idPasswordHasher } from './auth/argon2id-password-hasher';
import { type AccessTokenVerifier } from './auth/access-token-verifier';
import { createAuthRouter } from './auth/auth.router';
import { createAuthenticateMiddleware } from './auth/authenticate.middleware';
import { DenylistBreachedPasswordChecker } from './auth/denylist-breached-password-checker';
import { LoginService } from './auth/login.service';
import { LogoutService } from './auth/logout.service';
import { RefreshService } from './auth/refresh.service';
import { RegisterService } from './auth/register.service';
import { type TokenService } from './auth/token-service';
import { createPrismaClient } from './repositories/create-prisma-client';
import { PrismaRefreshTokenRepository } from './repositories/prisma-refresh-token.repository';
import { PrismaRoleRepository } from './repositories/prisma-role.repository';
import { PrismaUnitOfWork } from './repositories/prisma-unit-of-work';
import { PrismaUserRepository } from './repositories/prisma-user.repository';
import { GetCurrentUserService } from './users/get-current-user.service';
import { createUsersRouter } from './users/users.router';

const DUMMY_PASSWORD_BYTES = 32;

export interface ComposeAuthRouterOptions {
  /** The service's Postgres pool. The caller owns it and closes it on shutdown. */
  readonly pool: Pool;
  readonly logger: Logger;
  /** Signs access tokens and creates refresh tokens. */
  readonly tokenService: TokenService;
  /** Checks the access tokens of routes that require sign-in. */
  readonly accessTokenVerifier: AccessTokenVerifier;
  /** From `REFRESH_REUSE_GRACE_MS`. */
  readonly refreshReuseGraceMs: number;
}

/**
 * Part of the composition root (with `server.ts`): the only place that names the concrete
 * repositories, hasher and breached-password checker and connects them to the services.
 *
 * Makes the dummy hash that login verifies against for unknown emails. It is made here, once,
 * with the same hasher and so the same parameters as real hashes, from a random password that is
 * thrown away.
 *
 * @param options - The pool, logger, token service, access-token verifier and refresh grace window.
 * @returns The routers for the authentication endpoints and the signed-in user's endpoints.
 */
export async function composeAuthRouter(
  options: ComposeAuthRouterOptions,
): Promise<readonly Router[]> {
  const { pool, logger, tokenService } = options;
  const prisma = createPrismaClient(pool);
  const userRepository = new PrismaUserRepository(prisma);
  const roleRepository = new PrismaRoleRepository(prisma);
  const unitOfWork = new PrismaUnitOfWork(prisma);
  const refreshTokenRepository = new PrismaRefreshTokenRepository(prisma);
  const passwordHasher = new Argon2idPasswordHasher();
  const authRouter = createAuthRouter({
    registerService: new RegisterService({
      userRepository,
      roleRepository,
      unitOfWork,
      passwordHasher,
      breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
      logger,
    }),
    loginService: new LoginService({
      userRepository,
      roleRepository,
      refreshTokenRepository,
      unitOfWork,
      passwordHasher,
      tokenService,
      dummyPasswordHash: await passwordHasher.hash(
        randomBytes(DUMMY_PASSWORD_BYTES).toString('base64'),
      ),
      logger,
    }),
    refreshService: new RefreshService({
      userRepository,
      roleRepository,
      refreshTokenRepository,
      unitOfWork,
      tokenService,
      reuseGraceMs: options.refreshReuseGraceMs,
      logger,
    }),
    logoutService: new LogoutService({ refreshTokenRepository, unitOfWork, logger }),
  });
  const usersRouter = createUsersRouter({
    authenticate: createAuthenticateMiddleware({ verifier: options.accessTokenVerifier, logger }),
    getCurrentUserService: new GetCurrentUserService({ userRepository, roleRepository, logger }),
  });
  return [authRouter, usersRouter];
}
