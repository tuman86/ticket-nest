import { randomUUID } from 'node:crypto';

import {
  type CreateRefreshTokenInput,
  type RefreshTokenRecord,
  type RefreshTokenRepository,
} from '@/repositories/refresh-token.repository';
import { type RoleRecord, type RoleRepository } from '@/repositories/role.repository';
import { type Transaction, type UnitOfWork } from '@/repositories/transaction';
import {
  type CreateUserInput,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from '@/repositories/user.repository';
import { EmailAlreadyRegisteredError } from '@/users/email-already-registered.error';

const FAKE_TRANSACTION: Transaction = { isTransaction: true };

/** Role ids used by the in-memory role repository. */
export const CUSTOMER_ROLE: RoleRecord = {
  id: '7c1a9b52-1c47-4e0a-8a3b-6d3e1f0b2a10',
  key: 'CUSTOMER',
  name: 'Customer',
};

/** A fake that can capture its state and give back a function that restores it. */
export interface Snapshottable {
  /** @returns A function that puts the state back as it was when this was called. */
  takeSnapshot(): () => void;
}

/** `UserRepository` in memory. Like the database, it refuses a second user with the same email. */
export class InMemoryUserRepository implements UserRepository, Snapshottable {
  private readonly users = new Map<string, UserRecord>();

  /** @inheritdoc */
  takeSnapshot(): () => void {
    const copy = new Map(this.users);
    return () => {
      this.users.clear();
      for (const [id, user] of copy) {
        this.users.set(id, user);
      }
    };
  }

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
  updatePasswordHashIfUnchanged(
    id: string,
    expectedPasswordHash: string,
    passwordHash: string,
  ): Promise<boolean> {
    const user = this.users.get(id);
    if (user?.passwordHash !== expectedPasswordHash) {
      return Promise.resolve(false);
    }
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
  findById(id: string): Promise<RoleRecord | null> {
    return Promise.resolve(this.roles.find((role) => role.id === id) ?? null);
  }

  /** @inheritdoc */
  findByKey(key: string): Promise<RoleRecord | null> {
    return Promise.resolve(this.roles.find((role) => role.key === key) ?? null);
  }
}

/** `RefreshTokenRepository` in memory. Only `create` and the reads are used by login. */
export class InMemoryRefreshTokenRepository implements RefreshTokenRepository, Snapshottable {
  private readonly tokens = new Map<string, RefreshTokenRecord>();

  /** @inheritdoc */
  takeSnapshot(): () => void {
    const copy = new Map(this.tokens);
    return () => {
      this.tokens.clear();
      for (const [id, token] of copy) {
        this.tokens.set(id, token);
      }
    };
  }

  /** @returns Every stored token, oldest first. */
  all(): readonly RefreshTokenRecord[] {
    return [...this.tokens.values()];
  }

  /** @inheritdoc */
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    const token: RefreshTokenRecord = {
      ...input,
      id: randomUUID(),
      rotatedAt: null,
      replacedById: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.tokens.set(token.id, token);
    return Promise.resolve(token);
  }

  /** @inheritdoc */
  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return Promise.resolve(this.all().find((token) => token.tokenHash === tokenHash) ?? null);
  }

  /** @inheritdoc */
  markRotated(id: string, replacedById: string, rotatedAt: Date): Promise<boolean> {
    const token = this.tokens.get(id);
    const isActive = token?.rotatedAt === null && token.revokedAt === null;
    if (!isActive) {
      return Promise.resolve(false);
    }
    this.tokens.set(id, { ...token, rotatedAt, replacedById });
    return Promise.resolve(true);
  }

  /** @inheritdoc */
  revokeFamily(familyId: string, revokedAt: Date): Promise<number> {
    return Promise.resolve(this.revokeWhere((token) => token.familyId === familyId, revokedAt));
  }

  /** @inheritdoc */
  revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    return Promise.resolve(this.revokeWhere((token) => token.userId === userId, revokedAt));
  }

  /** @inheritdoc */
  deleteExpired(before: Date, limit: number): Promise<number> {
    const expired = this.all()
      .filter((token) => token.expiresAt < before)
      .slice(0, limit);
    for (const token of expired) {
      this.tokens.delete(token.id);
    }
    return Promise.resolve(expired.length);
  }

  private revokeWhere(matches: (token: RefreshTokenRecord) => boolean, revokedAt: Date): number {
    let count = 0;
    for (const token of this.all()) {
      if (matches(token) && token.revokedAt === null) {
        this.tokens.set(token.id, { ...token, revokedAt });
        count += 1;
      }
    }
    return count;
  }
}

/** `UnitOfWork` that just runs the work. The in-memory repositories have nothing to roll back. */
export class InlineUnitOfWork implements UnitOfWork {
  /** @inheritdoc */
  run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result> {
    return work(FAKE_TRANSACTION);
  }
}

/**
 * `UnitOfWork` for in-memory fakes that undoes their changes when the work throws, like a real
 * rollback. Needed to test paths that deliberately abort a transaction.
 */
export class RollbackUnitOfWork implements UnitOfWork {
  /**
   * @param participants - The fakes whose changes are rolled back.
   */
  constructor(private readonly participants: readonly Snapshottable[]) {}

  /** @inheritdoc */
  async run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result> {
    const restores = this.participants.map((participant) => participant.takeSnapshot());
    try {
      return await work(FAKE_TRANSACTION);
    } catch (error) {
      for (const restore of restores) {
        restore();
      }
      throw error;
    }
  }
}

/**
 * `UnitOfWork` that gives every run its own new handle and remembers it, so a test can check that
 * the handle a service passes on is the one this unit of work opened.
 */
export class HandleRecordingUnitOfWork implements UnitOfWork {
  /** The handle given to each run, in order. */
  readonly handles: Transaction[] = [];

  /** @inheritdoc */
  run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result> {
    const handle: Transaction = { isTransaction: true };
    this.handles.push(handle);
    return work(handle);
  }
}
