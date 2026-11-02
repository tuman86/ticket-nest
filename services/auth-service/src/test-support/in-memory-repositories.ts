import { randomUUID } from 'node:crypto';

import { type RoleRecord, type RoleRepository } from '../repositories/role.repository';
import { type Transaction, type UnitOfWork } from '../repositories/transaction';
import {
  type CreateUserInput,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from '../repositories/user.repository';
import { EmailAlreadyRegisteredError } from '../users/email-already-registered.error';

const FAKE_TRANSACTION: Transaction = { isTransaction: true };

/** Role ids used by the in-memory role repository. */
export const CUSTOMER_ROLE: RoleRecord = {
  id: '7c1a9b52-1c47-4e0a-8a3b-6d3e1f0b2a10',
  key: 'CUSTOMER',
  name: 'Customer',
};

/** `UserRepository` in memory. Like the database, it refuses a second user with the same email. */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>();

  /** @returns Every stored user, oldest first. */
  all(): readonly UserRecord[] {
    return [...this.users.values()];
  }

  /** @inheritdoc */
  findById(id: string): Promise<UserRecord | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  /** @inheritdoc */
  findByEmail(normalizedEmail: string): Promise<UserRecord | null> {
    const found = this.all().find((user) => user.email === normalizedEmail);
    return Promise.resolve(found ?? null);
  }

  /** @inheritdoc */
  create(input: CreateUserInput): Promise<UserRecord> {
    if (this.all().some((user) => user.email === input.email)) {
      return Promise.reject(new EmailAlreadyRegisteredError());
    }
    const now = new Date();
    const user: UserRecord = {
      ...input,
      id: randomUUID(),
      emailVerifiedAt: null,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  /** @inheritdoc */
  updatePasswordHash(id: string, passwordHash: string): Promise<boolean> {
    return Promise.resolve(this.update(id, { passwordHash }));
  }

  /** @inheritdoc */
  updateStatus(id: string, status: UserStatus): Promise<boolean> {
    return Promise.resolve(this.update(id, { status }));
  }

  /** @inheritdoc */
  markEmailVerified(id: string, verifiedAt: Date): Promise<boolean> {
    const user = this.users.get(id);
    return Promise.resolve(
      user !== undefined &&
        this.update(id, { emailVerifiedAt: user.emailVerifiedAt ?? verifiedAt }),
    );
  }

  private update(id: string, changes: Partial<UserRecord>): boolean {
    const user = this.users.get(id);
    if (user === undefined) {
      return false;
    }
    this.users.set(id, { ...user, ...changes, updatedAt: new Date() });
    return true;
  }
}

/** `RoleRepository` that knows only the `CUSTOMER` role unless given others. */
export class InMemoryRoleRepository implements RoleRepository {
  /**
   * @param roles - The roles that exist.
   */
  constructor(private readonly roles: readonly RoleRecord[] = [CUSTOMER_ROLE]) {}

  /** @inheritdoc */
  findByKey(key: string): Promise<RoleRecord | null> {
    return Promise.resolve(this.roles.find((role) => role.key === key) ?? null);
  }
}

/** `UnitOfWork` that just runs the work. The in-memory repositories have nothing to roll back. */
export class InlineUnitOfWork implements UnitOfWork {
  /** @inheritdoc */
  run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result> {
    return work(FAKE_TRANSACTION);
  }
}
