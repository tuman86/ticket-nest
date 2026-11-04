import { InternalServerError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import { type RoleRecord, type RoleRepository } from '../repositories/role.repository';
import { type UnitOfWork } from '../repositories/transaction';
import { type UserRecord, type UserRepository } from '../repositories/user.repository';
import { EmailAlreadyRegisteredError } from '../users/email-already-registered.error';
import { normalizeEmail } from '../users/normalize-email';

import { type BreachedPasswordChecker } from './breached-password-checker';
import { BreachedPasswordError } from './breached-password.error';
import { type PasswordHasher } from './password-hasher';
import { type UserRegisteredEventRecorder } from './user-registered-event-recorder';

const CUSTOMER_ROLE_KEY = 'CUSTOMER';

export interface RegisterServiceDependencies {
  readonly userRepository: UserRepository;
  readonly roleRepository: RoleRepository;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly breachedPasswordChecker: BreachedPasswordChecker;
  /** Writes the `user.registered` outbox row inside the registration transaction. */
  readonly userRegisteredEventRecorder: UserRegisteredEventRecorder;
  readonly logger: Logger;
}

/** Validated registration data. The controller has already parsed it with Zod. */
export interface RegisterCustomerInput {
  /** As typed by the user. The service normalizes it. */
  readonly email: string;
  /** Plaintext. Only ever handed to the hasher. */
  readonly password: string;
  readonly name: string;
  /** E.164, when given. */
  readonly phone?: string | undefined;
}

export interface RegisteredCustomer {
  readonly user: UserRecord;
  readonly role: RoleRecord;
}

/** Business rules for creating a customer account. */
export class RegisterService {
  /**
   * @param dependencies - Repositories, hasher, password checker and logger, all injected.
   */
  constructor(private readonly dependencies: RegisterServiceDependencies) {}

  /**
   * Creates a `CUSTOMER` account. The role is fixed here and never read from the request, so a
   * caller cannot register as staff. Issues no tokens; the user logs in afterwards.
   *
   * Order matters: the cheap checks (breached password, existing email) run before the costly
   * hash, so rejected requests cannot be used to burn CPU. The hash is computed before the
   * transaction opens, so the transaction stays short. The `user.registered` outbox row is written
   * in that same transaction, so a user never exists without its event and the reverse.
   *
   * @param input - Validated registration data.
   * @returns The stored user and its role.
   * @throws BreachedPasswordError when the password is on the breached or common list.
   * @throws EmailAlreadyRegisteredError when an account with this email exists, including when a
   * concurrent request created it first (the unique index decides).
   * @throws InternalServerError when the built-in `CUSTOMER` role is missing from the database.
   * @throws InvalidOutboxEventError when the event does not match its contract (a bug in this
   * service). The user is not created.
   * @throws Error when the database rejects the user or the outbox row. The transaction rolls back,
   * so neither is stored, and the error handler answers a generic 500.
   */
  async registerCustomer(input: RegisterCustomerInput): Promise<RegisteredCustomer> {
    const { userRepository, unitOfWork, passwordHasher, userRegisteredEventRecorder, logger } =
      this.dependencies;

    await this.assertPasswordNotBreached(input.password);
    const email = normalizeEmail(input.email);
    if ((await userRepository.findByEmail(email)) !== null) {
      throw new EmailAlreadyRegisteredError();
    }
    const role = await this.findCustomerRole();
    const passwordHash = await passwordHasher.hash(input.password);

    const user = await unitOfWork.run(async (tx) => {
      const created = await userRepository.create(
        {
          email,
          passwordHash,
          name: input.name,
          phone: input.phone ?? null,
          roleId: role.id,
          tenantId: null,
        },
        tx,
      );
      await userRegisteredEventRecorder.record(tx, created, role);
      return created;
    });

    // The user id only: never the email, password or hash.
    logger.info({ userId: user.id }, 'user registered');
    return { user, role };
  }

  /**
   * @param password - The plaintext password.
   * @throws BreachedPasswordError when the password is breached or too common.
   */
  private async assertPasswordNotBreached(password: string): Promise<void> {
    if (await this.dependencies.breachedPasswordChecker.isBreached(password)) {
      throw new BreachedPasswordError();
    }
  }

  /**
   * @returns The built-in customer role.
   * @throws InternalServerError when the migration's seed data is missing.
   */
  private async findCustomerRole(): Promise<RoleRecord> {
    const role = await this.dependencies.roleRepository.findByKey(CUSTOMER_ROLE_KEY);
    if (role === null) {
      throw new InternalServerError({ detail: `Built-in role ${CUSTOMER_ROLE_KEY} is missing.` });
    }
    return role;
  }
}
