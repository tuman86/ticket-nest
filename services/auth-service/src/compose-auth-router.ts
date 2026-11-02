import { type Logger } from '@ticketnest/logger';
import { type Router } from 'express';
import { type Pool } from 'pg';

import { Argon2idPasswordHasher } from './auth/argon2id-password-hasher';
import { createAuthRouter } from './auth/auth.router';
import { DenylistBreachedPasswordChecker } from './auth/denylist-breached-password-checker';
import { RegisterService } from './auth/register.service';
import { createPrismaClient } from './repositories/create-prisma-client';
import { PrismaRoleRepository } from './repositories/prisma-role.repository';
import { PrismaUnitOfWork } from './repositories/prisma-unit-of-work';
import { PrismaUserRepository } from './repositories/prisma-user.repository';

/**
 * Part of the composition root (with `server.ts`): the only place that names the concrete
 * repositories, hasher and breached-password checker and connects them to the services.
 *
 * @param pool - The service's Postgres pool. The caller owns it and closes it on shutdown.
 * @param logger - The service logger.
 * @returns The router for the public authentication endpoints.
 */
export function composeAuthRouter(pool: Pool, logger: Logger): Router {
  const prisma = createPrismaClient(pool);
  return createAuthRouter({
    registerService: new RegisterService({
      userRepository: new PrismaUserRepository(prisma),
      roleRepository: new PrismaRoleRepository(prisma),
      unitOfWork: new PrismaUnitOfWork(prisma),
      passwordHasher: new Argon2idPasswordHasher(),
      breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
      logger,
    }),
  });
}
