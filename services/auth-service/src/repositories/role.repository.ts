import { type Transaction } from './transaction';

/** The part of a `roles` row that other code needs. */
export interface RoleRecord {
  readonly id: string;
  /** Stable machine key such as `CUSTOMER`. */
  readonly key: string;
  readonly name: string;
}

/** Storage for roles. Only this repository touches `roles`. */
export interface RoleRepository {
  /**
   * @param id - The role's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role, or null when no role has this id.
   */
  findById(id: string, tx?: Transaction): Promise<RoleRecord | null>;

  /**
   * @param key - The role's key, for example `CUSTOMER`.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role, or null when no role has this key.
   */
  findByKey(key: string, tx?: Transaction): Promise<RoleRecord | null>;

  /**
   * Reads the permission keys a role holds. Tokens carry them (ADR-0025), so the order is fixed:
   * sorted by UTF-16 code unit in code, not by the database collation, which differs between
   * servers.
   *
   * @param roleId - The role's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role's keys without repeats. Empty for a role with no grants and for an unknown
   * role, which a caller that needs the difference checks with `findById`.
   */
  findPermissionKeys(roleId: string, tx?: Transaction): Promise<readonly string[]>;
}
