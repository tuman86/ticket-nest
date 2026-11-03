import { type Logger } from '@ticketnest/logger';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { LoginService } from '@/auth/login.service';

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
