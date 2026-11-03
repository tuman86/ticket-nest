import { type Transaction } from './transaction';

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** A row of `users`, as the rest of the service sees it. */
export interface UserRecord {
  readonly id: string;
  /** Normalized: trimmed and lower-cased. */
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  /** Null until the user sets a password. */
  readonly passwordHash: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly roleId: string;
  /** Operator (tenant) id from the catalog service. Set only for operator users. */
  readonly tenantId: string | null;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateUserInput {
  /** Must already be normalized with `normalizeEmail`. */
  readonly email: string;
  readonly passwordHash: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly roleId: string;
  readonly tenantId: string | null;
}

/** Storage for users. Only this repository writes to `users`. */
export interface UserRepository {
  /**
   * @param id - The user's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The user, or null when no user has this id.
   */
  findById(id: string, tx?: Transaction): Promise<UserRecord | null>;

  /**
   * @param normalizedEmail - The email after `normalizeEmail`.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The user, or null when no user has this email.
   */
  findByEmail(normalizedEmail: string, tx?: Transaction): Promise<UserRecord | null>;

  /**
   * Inserts a new, active user.
   *
   * @param input - The user's data.
   * @param tx - The open transaction.
   * @returns The stored user.
   * @throws EmailAlreadyRegisteredError when the email is taken.
   */
  create(input: CreateUserInput, tx: Transaction): Promise<UserRecord>;

  /**
   * @param id - The user's id.
   * @param passwordHash - The new argon2id hash.
   * @param tx - The open transaction.
   * @returns True when the user exists and was updated.
   */
  updatePasswordHash(id: string, passwordHash: string, tx: Transaction): Promise<boolean>;

  /**
   * Replaces the password hash only while it still equals the one the caller verified against
   * (compare-and-set). Used to upgrade a hash after login without overwriting a password that was
   * changed while the login was in flight.
   *
   * @param id - The user's id.
   * @param expectedPasswordHash - The hash the caller read and verified.
   * @param passwordHash - The new argon2id hash.
   * @param tx - The open transaction.
   * @returns True when the hash was replaced, false when the user is gone or the hash changed.
   */
  updatePasswordHashIfUnchanged(
    id: string,
    expectedPasswordHash: string,
    passwordHash: string,
    tx: Transaction,
  ): Promise<boolean>;

  /**
   * @param id - The user's id.
   * @param status - The new status.
   * @param tx - The open transaction.
   * @returns True when the user exists and was updated.
   */
  updateStatus(id: string, status: UserStatus, tx: Transaction): Promise<boolean>;

  /**
   * Records that the user proved control of their email. Keeps the earliest time if already set.
   *
   * @param id - The user's id.
   * @param verifiedAt - When the proof happened.
   * @param tx - The open transaction.
   * @returns True when the user exists (whether or not the time changed).
   */
  markEmailVerified(id: string, verifiedAt: Date, tx: Transaction): Promise<boolean>;
}
