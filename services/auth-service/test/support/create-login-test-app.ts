import { randomBytes } from 'node:crypto';

import { vi, type MockInstance } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { LoginService } from '@/auth/login.service';
import { RegisterService } from '@/auth/register.service';
import { type UserRecord } from '@/repositories/user.repository';

import { createTestApp, type TestApp } from './create-test-app';
import {
  CUSTOMER_ROLE,
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
  type TestSigningKeys,
} from './test-signing-keys';

export interface LoginTestApp extends TestApp {
  readonly users: InMemoryUserRepository;
  readonly refreshTokens: InMemoryRefreshTokenRepository;
  /** The hasher the login service uses, with `verify` spied on. */
  readonly hasher: Argon2idPasswordHasher;
  readonly verifySpy: MockInstance<Argon2idPasswordHasher['verify']>;
  readonly dummyPasswordHash: string;
  readonly keys: TestSigningKeys;
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

export interface LoginTestAppOptions {
  /** The hasher the service uses. Pass a stronger one to make stored hashes look old. */
  readonly hasher?: Argon2idPasswordHasher;
}

/**
 * Builds the real app and the real login router on in-memory repositories, the real argon2id
 * hasher and the real EdDSA token service, so the whole controller -> service -> repository
 * flow runs.
 *
 * @param options - Optional overrides.
 * @returns The app plus handles for assertions.
 */
export async function createLoginTestApp(options: LoginTestAppOptions = {}): Promise<LoginTestApp> {
  const users = new InMemoryUserRepository();
  const refreshTokens = new InMemoryRefreshTokenRepository();
  const hasher = options.hasher ?? new Argon2idPasswordHasher();
  const verifySpy = vi.spyOn(hasher, 'verify');
  const legacyHasher = new Argon2idPasswordHasher();
  const keys = generateTestSigningKeys();
  const dummyPasswordHash = await hasher.hash(randomBytes(32).toString('base64'));

  const testApp = createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          registerService: new RegisterService({
            userRepository: users,
            roleRepository: new InMemoryRoleRepository(),
            unitOfWork: new InlineUnitOfWork(),
            passwordHasher: hasher,
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: new LoginService({
            userRepository: users,
            roleRepository: new InMemoryRoleRepository(),
            refreshTokenRepository: refreshTokens,
            unitOfWork: new InlineUnitOfWork(),
            passwordHasher: hasher,
            tokenService: new EdDsaTokenService({
              privateKey: keys.privateKey,
              keyId: TEST_KEY_ID,
              issuer: TEST_ISSUER,
              audience: TEST_AUDIENCE,
            }),
            dummyPasswordHash,
            logger,
          }),
        }),
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
