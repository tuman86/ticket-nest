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
   * @param key - The role's key, for example `CUSTOMER`.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role, or null when no role has this key.
   */
  findByKey(key: string, tx?: Transaction): Promise<RoleRecord | null>;
}
