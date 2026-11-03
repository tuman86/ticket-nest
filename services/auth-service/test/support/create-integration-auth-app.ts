import { createPublicKey } from 'node:crypto';

import { type Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { createAuthenticateMiddleware } from '@/auth/authenticate.middleware';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { EdDsaAccessTokenVerifier } from '@/auth/eddsa-access-token-verifier';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { LoginService } from '@/auth/login.service';
import { LogoutService } from '@/auth/logout.service';
import { RefreshService } from '@/auth/refresh.service';
import { RegisterService } from '@/auth/register.service';
import { GetCurrentUserService } from '@/users/get-current-user.service';
import { createUsersRouter } from '@/users/users.router';

import { createTestApp, type TestApp } from './create-test-app';
import { createPassThroughRateLimiters } from './pass-through-rate-limiters';
import { type TestClock } from './test-clock';
import { type TestDatabase } from './test-database';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_KEY_ID, type TestSigningKeys } from './test-signing-keys';

export const INTEGRATION_REUSE_GRACE_MS = 10_000;

export interface IntegrationAuthAppOptions {
  readonly database: TestDatabase;
  readonly keys: TestSigningKeys;
  readonly clock: TestClock;
  readonly hasher: Argon2idPasswordHasher;
}

/**
 * Builds the real app with every auth and users route on the real Postgres repositories, the real
 * hasher and the real EdDSA signer and verifier, so a whole session can be driven over HTTP.
 *
 * @param options - The database, signing keys, clock and hasher the test owns.
 * @returns The app and its collected log lines.
 */
export async function createIntegrationAuthApp(
  options: IntegrationAuthAppOptions,
): Promise<TestApp> {
  const { database, keys, clock, hasher } = options;
  const tokenService = new EdDsaTokenService({
    privateKey: keys.privateKey,
    keyId: TEST_KEY_ID,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    now: clock.now,
  });
  const dummyPasswordHash = await hasher.hash('a password nobody knows');
  return createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          rateLimiters: createPassThroughRateLimiters(),
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: hasher,
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: new LoginService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: hasher,
            tokenService,
            dummyPasswordHash,
            logger,
            now: clock.now,
          }),
          refreshService: new RefreshService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            tokenService,
            reuseGraceMs: INTEGRATION_REUSE_GRACE_MS,
            logger,
            now: clock.now,
          }),
          logoutService: new LogoutService({
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            logger,
            now: clock.now,
          }),
        }),
        createUsersRouter({
          authenticate: createAuthenticateMiddleware({
            verifier: new EdDsaAccessTokenVerifier({
              verificationKeys: new Map([[TEST_KEY_ID, createPublicKey(keys.privateKey)]]),
              issuer: TEST_ISSUER,
              audience: TEST_AUDIENCE,
              now: clock.now,
            }),
            logger,
          }),
          getCurrentUserService: new GetCurrentUserService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            logger,
          }),
        }),
      ],
    },
  );
}
