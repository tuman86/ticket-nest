import { randomBytes } from 'node:crypto';

import { type Logger } from '@ticketnest/logger';
import { type Router } from 'express';
import { type Pool } from 'pg';

import { Argon2idPasswordHasher } from './auth/argon2id-password-hasher';
import { createAuthRouter } from './auth/auth.router';
import { DenylistBreachedPasswordChecker } from './auth/denylist-breached-password-checker';
import { LoginService } from './auth/login.service';
import { RegisterService } from './auth/register.service';
import { type TokenService } from './auth/token-service';
import { createPrismaClient } from './repositories/create-prisma-client';
import { PrismaRefreshTokenRepository } from './repositories/prisma-refresh-token.repository';
import { PrismaRoleRepository } from './repositories/prisma-role.repository';
import { PrismaUnitOfWork } from './repositories/prisma-unit-of-work';
import { PrismaUserRepository } from './repositories/prisma-user.repository';

const DUMMY_PASSWORD_BYTES = 32;

/**
 * Part of the composition root (with `server.ts`): the only place that names the concrete
 * repositories, hasher and breached-password checker and connects them to the services.
 *
 * Makes the dummy hash that login verifies against for unknown emails. It is made here, once,
 * with the same hasher and so the same parameters as real hashes, from a random password that is
 * thrown away.
 *
 * @param pool - The service's Postgres pool. The caller owns it and closes it on shutdown.
 * @param logger - The service logger.
 * @param tokenService - Signs access tokens and creates refresh tokens.
 * @returns The router for the public authentication endpoints.
 */
export async function composeAuthRouter(
  pool: Pool,
  logger: Logger,
  tokenService: TokenService,
): Promise<Router> {
  const prisma = createPrismaClient(pool);
  const userRepository = new PrismaUserRepository(prisma);
  const roleRepository = new PrismaRoleRepository(prisma);
  const unitOfWork = new PrismaUnitOfWork(prisma);
  const passwordHasher = new Argon2idPasswordHasher();
  return createAuthRouter({
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
      refreshTokenRepository: new PrismaRefreshTokenRepository(prisma),
      unitOfWork,
      passwordHasher,
      tokenService,
      dummyPasswordHash: await passwordHasher.hash(
        randomBytes(DUMMY_PASSWORD_BYTES).toString('base64'),
      ),
      logger,
    }),
  });
}
