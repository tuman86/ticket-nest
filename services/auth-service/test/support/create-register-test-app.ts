import { vi, type MockInstance } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { RegisterService } from '@/auth/register.service';

import { createTestApp, type TestApp } from './create-test-app';
import {
  createUnusedLoginService,
  createUnusedLogoutService,
  createUnusedRefreshService,
} from './create-unused-auth-services';
import {
  InMemoryRoleRepository,
  InMemoryUserRepository,
  InlineUnitOfWork,
} from './in-memory-repositories';

export interface RegisterTestApp extends TestApp {
  readonly users: InMemoryUserRepository;
  readonly hasher: Argon2idPasswordHasher;
  /** Spy on `hasher.hash`: tells a test whether a request reached the expensive step. */
  readonly hashSpy: MockInstance<Argon2idPasswordHasher['hash']>;
}

/**
 * Builds the real app and the real register router on in-memory repositories and the real
 * argon2id hasher, so the whole controller -> service -> repository flow runs.
 *
 * @returns The app plus handles for assertions.
 */
export function createRegisterTestApp(): RegisterTestApp {
  const users = new InMemoryUserRepository();
  const hasher = new Argon2idPasswordHasher();
  const hashSpy = vi.spyOn(hasher, 'hash');
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
          loginService: createUnusedLoginService(logger),
          refreshService: createUnusedRefreshService(logger),
          logoutService: createUnusedLogoutService(logger),
        }),
      ],
    },
  );
  return { ...testApp, users, hasher, hashSpy };
}
