import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { EmailAlreadyRegisteredError } from '../users/email-already-registered.error';

import { selectExecutor } from './prisma-transaction';
import { type Transaction } from './transaction';
import {
  type CreateUserInput,
  type UserRecord,
  type UserRepository,
  type UserStatus,
} from './user.repository';

const UNIQUE_CONSTRAINT_ERROR_CODE = 'P2002';

/** `UserRepository` backed by Prisma. */
export class PrismaUserRepository implements UserRepository {
  /**
   * @param client - The shared Prisma client, used for reads outside a transaction.
   */
  constructor(private readonly client: PrismaClient) {}

  /**
   * @param id - The user's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The user, or null when no user has this id.
   */
  findById(id: string, tx?: Transaction): Promise<UserRecord | null> {
    return selectExecutor(this.client, tx).user.findUnique({ where: { id } });
  }

  /**
   * @param normalizedEmail - The email after `normalizeEmail`.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The user, or null when no user has this email.
   */
  findByEmail(normalizedEmail: string, tx?: Transaction): Promise<UserRecord | null> {
    return selectExecutor(this.client, tx).user.findUnique({ where: { email: normalizedEmail } });
  }

  /**
   * Inserts a new, active user.
   *
   * @param input - The user's data.
   * @param tx - The open transaction.
   * @returns The stored user.
   * @throws EmailAlreadyRegisteredError when the email is taken.
   */
  async create(input: CreateUserInput, tx: Transaction): Promise<UserRecord> {
    try {
      return await selectExecutor(this.client, tx).user.create({ data: input });
    } catch (error) {
      // The only unique constraint a new user can hit is the email (the id is generated).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_ERROR_CODE
      ) {
        throw new EmailAlreadyRegisteredError({ cause: error });
      }
      throw error;
    }
  }

  /**
   * @param id - The user's id.
   * @param passwordHash - The new argon2id hash.
   * @param tx - The open transaction.
   * @returns True when the user exists and was updated.
   */
  async updatePasswordHash(id: string, passwordHash: string, tx: Transaction): Promise<boolean> {
    const result = await selectExecutor(this.client, tx).user.updateMany({
      where: { id },
      data: { passwordHash },
    });
    return result.count > 0;
  }

  /**
   * Replaces the password hash only while it still equals `expectedPasswordHash`.
   *
   * @param id - The user's id.
   * @param expectedPasswordHash - The hash the caller read and verified.
   * @param passwordHash - The new argon2id hash.
   * @param tx - The open transaction.
   * @returns True when the hash was replaced, false when the user is gone or the hash changed.
   */
  async updatePasswordHashIfUnchanged(
    id: string,
    expectedPasswordHash: string,
    passwordHash: string,
    tx: Transaction,
  ): Promise<boolean> {
    const result = await selectExecutor(this.client, tx).user.updateMany({
      where: { id, passwordHash: expectedPasswordHash },
      data: { passwordHash },
    });
    return result.count > 0;
  }

  /**
   * @param id - The user's id.
   * @param status - The new status.
   * @param tx - The open transaction.
   * @returns True when the user exists and was updated.
   */
  async updateStatus(id: string, status: UserStatus, tx: Transaction): Promise<boolean> {
    const result = await selectExecutor(this.client, tx).user.updateMany({
      where: { id },
      data: { status },
    });
    return result.count > 0;
  }

  /**
   * Records that the user proved control of their email. Keeps the earliest time if already set.
   *
   * @param id - The user's id.
   * @param verifiedAt - When the proof happened.
   * @param tx - The open transaction.
   * @returns True when the user exists (whether or not the time changed).
   */
  async markEmailVerified(id: string, verifiedAt: Date, tx: Transaction): Promise<boolean> {
    const executor = selectExecutor(this.client, tx);
    await executor.user.updateMany({
      where: { id, emailVerifiedAt: null },
      data: { emailVerifiedAt: verifiedAt },
    });
    const user = await executor.user.findUnique({ where: { id }, select: { id: true } });
    return user !== null;
  }
}
