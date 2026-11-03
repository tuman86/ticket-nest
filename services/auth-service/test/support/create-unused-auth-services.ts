import { type Logger } from '@ticketnest/logger';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { LoginService } from '@/auth/login.service';
import { LogoutService } from '@/auth/logout.service';
import { RefreshService } from '@/auth/refresh.service';

import {
  InMemoryRefreshTokenRepository,
  InMemoryRoleRepository,
  InMemoryUserRepository,
  InlineUnitOfWork,
} from './in-memory-repositories';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
} from './test-signing-keys';

/**
 * Builds a `RefreshService` for tests of other routes, where the auth router needs one but no
 * request ever reaches it. It runs on empty in-memory repositories, so a refresh would fail.
 *
 * @param logger - The test logger.
 * @returns A refresh service that is wired but unused.
 */
export function createUnusedRefreshService(logger: Logger): RefreshService {
  return new RefreshService({
    userRepository: new InMemoryUserRepository(),
    roleRepository: new InMemoryRoleRepository(),
    refreshTokenRepository: new InMemoryRefreshTokenRepository(),
    unitOfWork: new InlineUnitOfWork(),
    tokenService: new EdDsaTokenService({
      privateKey: generateTestSigningKeys().privateKey,
      keyId: TEST_KEY_ID,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    }),
    reuseGraceMs: 10_000,
    logger,
  });
}

/**
 * Builds a `LoginService` for tests of other routes, where the auth router needs one but no
 * request ever reaches it. It runs on empty in-memory repositories, so a login would fail.
 *
 * @param logger - The test logger.
 * @returns A login service that is wired but unused.
 */
export function createUnusedLoginService(logger: Logger): LoginService {
  return new LoginService({
    userRepository: new InMemoryUserRepository(),
    roleRepository: new InMemoryRoleRepository(),
    refreshTokenRepository: new InMemoryRefreshTokenRepository(),
    unitOfWork: new InlineUnitOfWork(),
    passwordHasher: new Argon2idPasswordHasher(),
    tokenService: new EdDsaTokenService({
      privateKey: generateTestSigningKeys().privateKey,
      keyId: TEST_KEY_ID,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    }),
    dummyPasswordHash: 'not-a-real-hash',
    logger,
  });
}

/**
 * Builds a `LogoutService` for tests of other routes, where the auth router needs one but no
 * request ever reaches it. It runs on empty in-memory repositories.
 *
 * @param logger - The test logger.
 * @returns A logout service that is wired but unused.
 */
export function createUnusedLogoutService(logger: Logger): LogoutService {
  return new LogoutService({
    refreshTokenRepository: new InMemoryRefreshTokenRepository(),
    unitOfWork: new InlineUnitOfWork(),
    logger,
  });
}
