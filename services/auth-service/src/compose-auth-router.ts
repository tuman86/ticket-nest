import { randomBytes } from 'node:crypto';

import { type AccessTokenVerifier } from '@ticketnest/auth-middleware';
import { createAuthenticateMiddleware } from '@ticketnest/auth-middleware/express';
import { type Logger } from '@ticketnest/logger';
import {
  EventEnvelopeBuilder,
  OutboxWriter,
  SystemClock,
  UuidGenerator,
} from '@ticketnest/messaging';
import { type RateLimiter, RateLimitService } from '@ticketnest/rate-limit';
import { type Router } from 'express';

import { Argon2idPasswordHasher } from './auth/argon2id-password-hasher';
import { createAuthRateLimiters } from './auth/auth-rate-limiters';
import { createAuthRouter } from './auth/auth.router';
import { DenylistBreachedPasswordChecker } from './auth/denylist-breached-password-checker';
import { createJwksRouter } from './auth/jwks.router';
import { type JwksService } from './auth/jwks.service';
import { LoginService } from './auth/login.service';
import { LogoutService } from './auth/logout.service';
import { RefreshService } from './auth/refresh.service';
import { RegisterService } from './auth/register.service';
import { type TokenService } from './auth/token-service';
import { UserRegisteredEventRecorder } from './auth/user-registered-event-recorder';
import { readOrCreateCorrelationId } from './correlation-id';
import { type DatabaseClient } from './repositories/create-prisma-client';
import { PrismaOutboxRepository } from './repositories/prisma-outbox.repository';
import { PrismaRefreshTokenRepository } from './repositories/prisma-refresh-token.repository';
import { PrismaRoleRepository } from './repositories/prisma-role.repository';
import { PrismaUnitOfWork } from './repositories/prisma-unit-of-work';
import { PrismaUserRepository } from './repositories/prisma-user.repository';
import { GetCurrentUserService } from './users/get-current-user.service';
import { createUsersRouter } from './users/users.router';

const DUMMY_PASSWORD_BYTES = 32;

export interface ComposeAuthRouterOptions {
  /** The service's Prisma client, over its Postgres pool. The caller owns both and closes them on shutdown. */
  readonly prisma: DatabaseClient;
  readonly logger: Logger;
  /** Signs access tokens and creates refresh tokens. */
  readonly tokenService: TokenService;
  /** Checks the access tokens of routes that require sign-in. */
  readonly accessTokenVerifier: AccessTokenVerifier;
  /** Serves the public keys at `/.well-known/jwks.json`. Holds no private key. */
  readonly jwksService: JwksService;
  /** From `REFRESH_REUSE_GRACE_MS`. */
  readonly refreshReuseGraceMs: number;
  /** Counts requests per key for the endpoint rate limits. The caller owns its Redis client. */
  readonly rateLimiter: RateLimiter;
  /** From `RATE_LIMIT_KEY_PEPPER`. */
  readonly rateLimitKeyPepper: string;
}

/** The repositories and the unit of work, all backed by the one Prisma client. */
interface Persistence {
  readonly userRepository: PrismaUserRepository;
  readonly roleRepository: PrismaRoleRepository;
  readonly refreshTokenRepository: PrismaRefreshTokenRepository;
  readonly outboxRepository: PrismaOutboxRepository;
  readonly unitOfWork: PrismaUnitOfWork;
}

/**
 * Builds the repositories over the service's Prisma client.
 *
 * @param prisma - The service's Prisma client.
 * @returns The repositories and the unit of work.
 */
function createPersistence(prisma: DatabaseClient): Persistence {
  return {
    userRepository: new PrismaUserRepository(prisma),
    roleRepository: new PrismaRoleRepository(prisma),
    refreshTokenRepository: new PrismaRefreshTokenRepository(prisma),
    outboxRepository: new PrismaOutboxRepository(),
    unitOfWork: new PrismaUnitOfWork(prisma),
  };
}

/**
 * Builds the authentication router: its services, rate limiters and the dummy hash.
 *
 * Makes the dummy hash that login verifies against for unknown emails. It is made here, once,
 * with the same hasher and so the same parameters as real hashes, from a random password that is
 * thrown away.
 *
 * @param options - The composition options.
 * @param persistence - The repositories and unit of work.
 * @returns The router for register, login, refresh and logout.
 */
async function createAuthEndpoints(
  options: ComposeAuthRouterOptions,
  persistence: Persistence,
): Promise<Router> {
  const { logger, tokenService } = options;
  const { userRepository, roleRepository, refreshTokenRepository, outboxRepository, unitOfWork } =
    persistence;
  const passwordHasher = new Argon2idPasswordHasher();
  return createAuthRouter({
    rateLimiters: createAuthRateLimiters({
      rateLimitService: new RateLimitService({
        rateLimiter: options.rateLimiter,
        keyPepper: options.rateLimitKeyPepper,
        logger,
      }),
    }),
    registerService: new RegisterService({
      userRepository,
      roleRepository,
      unitOfWork,
      passwordHasher,
      breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
      userRegisteredEventRecorder: new UserRegisteredEventRecorder({
        outboxWriter: new OutboxWriter(outboxRepository),
        envelopeBuilder: new EventEnvelopeBuilder({
          idGenerator: new UuidGenerator(),
          clock: new SystemClock(),
        }),
        readCorrelationId: readOrCreateCorrelationId,
      }),
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
}

/**
 * Part of the composition root (with `server.ts`): the only place that names the concrete
 * repositories, hasher and breached-password checker and connects them to the services.
 *
 * @param options - The Prisma client, logger, token service, access-token verifier, key set service, refresh
 *   grace window, rate limiter and its key pepper.
 * @returns The routers for the authentication endpoints, the signed-in user's endpoints and the key set.
 */
export async function composeAuthRouter(
  options: ComposeAuthRouterOptions,
): Promise<readonly Router[]> {
  const { logger } = options;
  const persistence = createPersistence(options.prisma);
  const usersRouter = createUsersRouter({
    authenticate: createAuthenticateMiddleware({ verifier: options.accessTokenVerifier, logger }),
    getCurrentUserService: new GetCurrentUserService({
      userRepository: persistence.userRepository,
      roleRepository: persistence.roleRepository,
      logger,
    }),
  });
  return [
    await createAuthEndpoints(options, persistence),
    usersRouter,
    createJwksRouter({ jwksService: options.jwksService }),
  ];
}
