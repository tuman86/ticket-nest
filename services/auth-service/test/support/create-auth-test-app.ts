import { randomBytes, type KeyObject } from 'node:crypto';

import { type Logger } from '@ticketnest/logger';
import { vi, type MockInstance } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { createAuthenticateMiddleware } from '@/auth/authenticate.middleware';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { EdDsaAccessTokenVerifier } from '@/auth/eddsa-access-token-verifier';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { JwksService } from '@/auth/jwks.service';
import { createJwksRouter } from '@/auth/jwks.router';
import { LoginService } from '@/auth/login.service';
import { LogoutService } from '@/auth/logout.service';
import { RefreshService } from '@/auth/refresh.service';
import { RegisterService } from '@/auth/register.service';
import { createSigningKeySet, type SigningKeySet } from '@/auth/signing-key-set';
import { type UserRecord } from '@/repositories/user.repository';
import { GetCurrentUserService } from '@/users/get-current-user.service';
import { createUsersRouter } from '@/users/users.router';

import { createTestApp, type TestApp } from './create-test-app';
import {
  CUSTOMER_ROLE,
  InMemoryRefreshTokenRepository,
  InMemoryRoleRepository,
  InMemoryUserRepository,
  RollbackUnitOfWork,
} from './in-memory-repositories';
import { TestClock } from './test-clock';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TestSigningKeys,
} from './test-signing-keys';

export const DEFAULT_TEST_REUSE_GRACE_MS = 10_000;

export interface AuthTestApp extends TestApp {
  readonly users: InMemoryUserRepository;
  readonly refreshTokens: InMemoryRefreshTokenRepository;
  /** The hasher the login service uses, with `verify` spied on. */
  readonly hasher: Argon2idPasswordHasher;
  readonly verifySpy: MockInstance<Argon2idPasswordHasher['verify']>;
  readonly dummyPasswordHash: string;
  readonly keys: TestSigningKeys;
  /** The key set the token service, the `/me` verifier and the JWKS endpoint all share. */
  readonly keySet: SigningKeySet;
  /** The `kid` of the signing key: the header of every token this app issues. */
  readonly keyId: string;
  /** Drives the time every service sees. Call `advance` to jump forward. */
  readonly clock: TestClock;
  /**
   * Stores a user whose hash was made with the default (older) parameters.
   *
   * @param input - Email, password and optional status.
   * @returns The stored user.
   */
  addUser(input: AddUserInput): Promise<UserRecord>;
}

export interface AddUserInput {
  readonly email: string;
  readonly password: string;
  readonly status?: 'ACTIVE' | 'DISABLED';
  /** Stores this hash as is, instead of hashing `password`. */
  readonly passwordHash?: string | null;
}

export interface AuthTestAppOptions {
  /** The hasher the service uses. Pass a stronger one to make stored hashes look old. */
  readonly hasher?: Argon2idPasswordHasher;
  /** Grace window of the refresh service. Defaults to 10 seconds. */
  readonly reuseGraceMs?: number;
  /** Verify-only public keys published next to the signing key (a retiring or upcoming key). */
  readonly additionalPublicKeys?: readonly KeyObject[];
}

/**
 * Builds the real app and the real auth and users routers (register, login, refresh, logout, me) on in-memory
 * repositories, the real argon2id hasher and the real EdDSA token service, so the whole
 * controller -> service -> repository flow runs.
 *
 * @param options - Optional overrides.
 * @returns The app plus handles for assertions.
 */
export async function createAuthTestApp(options: AuthTestAppOptions = {}): Promise<AuthTestApp> {
  const users = new InMemoryUserRepository();
  const refreshTokens = new InMemoryRefreshTokenRepository();
  const roles = new InMemoryRoleRepository();
  const unitOfWork = new RollbackUnitOfWork([users, refreshTokens]);
  const clock = new TestClock();
  const hasher = options.hasher ?? new Argon2idPasswordHasher();
  const verifySpy = vi.spyOn(hasher, 'verify');
  const legacyHasher = new Argon2idPasswordHasher();
  const keys = generateTestSigningKeys();
  const dummyPasswordHash = await hasher.hash(randomBytes(32).toString('base64'));
  const keySet = await createSigningKeySet({
    privateKey: keys.privateKey,
    additionalPublicKeys: options.additionalPublicKeys ?? [],
  });
  const tokenService = new EdDsaTokenService({
    privateKey: keySet.signingPrivateKey,
    keyId: keySet.signingKeyId,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    now: clock.now,
  });

  const testApp = createTestApp(
    {},
    {
      buildRouters: (logger: Logger) => [
        createAuthRouter({
          registerService: new RegisterService({
            userRepository: users,
            roleRepository: roles,
            unitOfWork,
            passwordHasher: hasher,
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: new LoginService({
            userRepository: users,
            roleRepository: roles,
            refreshTokenRepository: refreshTokens,
            unitOfWork,
            passwordHasher: hasher,
            tokenService,
            dummyPasswordHash,
            logger,
            now: clock.now,
          }),
          refreshService: new RefreshService({
            userRepository: users,
            roleRepository: roles,
            refreshTokenRepository: refreshTokens,
            unitOfWork,
            tokenService,
            reuseGraceMs: options.reuseGraceMs ?? DEFAULT_TEST_REUSE_GRACE_MS,
            logger,
            now: clock.now,
          }),
          logoutService: new LogoutService({
            refreshTokenRepository: refreshTokens,
            unitOfWork,
            logger,
            now: clock.now,
          }),
        }),
        createUsersRouter({
          authenticate: createAuthenticateMiddleware({
            verifier: new EdDsaAccessTokenVerifier({
              verificationKeys: keySet.verificationKeys,
              issuer: TEST_ISSUER,
              audience: TEST_AUDIENCE,
              now: clock.now,
            }),
            logger,
          }),
          getCurrentUserService: new GetCurrentUserService({
            userRepository: users,
            roleRepository: roles,
            logger,
          }),
        }),
        createJwksRouter({ jwksService: new JwksService(keySet.publicJwks) }),
      ],
    },
  );

  return {
    ...testApp,
    users,
    refreshTokens,
    hasher,
    verifySpy,
    dummyPasswordHash,
    keys,
    keySet,
    keyId: keySet.signingKeyId,
    clock,
    async addUser(input) {
      const user = await users.create({
        email: input.email,
        passwordHash:
          input.passwordHash === undefined
            ? await legacyHasher.hash(input.password)
            : input.passwordHash,
        name: 'Test User',
        phone: null,
        roleId: CUSTOMER_ROLE.id,
        tenantId: null,
      });
      if (input.status === 'DISABLED') {
        await users.updateStatus(user.id, 'DISABLED');
      }
      return (await users.findById(user.id)) ?? user;
    },
  };
}
