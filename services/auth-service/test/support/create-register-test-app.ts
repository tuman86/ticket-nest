import { type InMemoryOutboxStore } from '@ticketnest/messaging/testing';
import { vi, type MockInstance } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { RegisterService } from '@/auth/register.service';
import { type Transaction, type UnitOfWork } from '@/repositories/transaction';
import { type OutboxStore } from '@ticketnest/messaging';

import { createTestApp, type TestApp } from './create-test-app';
import { createTestUserRegisteredRecorder } from './create-user-registered-event-recorder';
import {
  createUnusedLoginService,
  createUnusedLogoutService,
  createUnusedRefreshService,
} from './create-unused-auth-services';
import { createPassThroughRateLimiters } from './pass-through-rate-limiters';
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
  /** The in-memory outbox. Stays empty when `outboxStore` replaced it. */
  readonly outbox: InMemoryOutboxStore<Transaction>;
}

export interface RegisterTestAppOptions {
  /** Replaces the outbox the recorder writes to, for example one that fails. */
  readonly outboxStore?: OutboxStore<Transaction>;
  /** Replaces the unit of work, for example one that rolls the fakes back. */
  readonly buildUnitOfWork?: (users: InMemoryUserRepository) => UnitOfWork;
}

/**
 * Builds the real app and the real register router on in-memory repositories and the real
 * argon2id hasher, so the whole controller -> service -> repository flow runs.
 *
 * @param options - Test wiring that replaces the outbox or the unit of work.
 * @returns The app plus handles for assertions.
 */
export function createRegisterTestApp(options: RegisterTestAppOptions = {}): RegisterTestApp {
  const users = new InMemoryUserRepository();
  const { recorder, outbox } = createTestUserRegisteredRecorder(options.outboxStore);
  const hasher = new Argon2idPasswordHasher();
  const hashSpy = vi.spyOn(hasher, 'hash');
  const testApp = createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          rateLimiters: createPassThroughRateLimiters(),
          registerService: new RegisterService({
            userRepository: users,
            roleRepository: new InMemoryRoleRepository(),
            unitOfWork: options.buildUnitOfWork?.(users) ?? new InlineUnitOfWork(),
            userRegisteredEventRecorder: recorder,
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
  return { ...testApp, users, hasher, hashSpy, outbox };
}
