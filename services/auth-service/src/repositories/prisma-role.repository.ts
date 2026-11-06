import { type PrismaClient } from '../generated/prisma/client';

import { selectExecutor } from './prisma-transaction';
import { type RoleRecord, type RoleRepository } from './role.repository';
import { type Transaction } from './transaction';

/** `RoleRepository` backed by Prisma. */
export class PrismaRoleRepository implements RoleRepository {
  /**
   * @param client - The shared Prisma client, used for reads outside a transaction.
   */
  constructor(private readonly client: PrismaClient) {}

  /**
   * @param id - The role's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role, or null when no role has this id.
   */
  findById(id: string, tx?: Transaction): Promise<RoleRecord | null> {
    return selectExecutor(this.client, tx).role.findUnique({
      where: { id },
      select: { id: true, key: true, name: true },
    });
  }

  /**
   * @param key - The role's key, for example `CUSTOMER`.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role, or null when no role has this key.
   */
  findByKey(key: string, tx?: Transaction): Promise<RoleRecord | null> {
    return selectExecutor(this.client, tx).role.findUnique({
      where: { key },
      select: { id: true, key: true, name: true },
    });
  }

  /**
   * @param roleId - The role's id.
   * @param tx - Transaction to read in, when the call is part of one.
   * @returns The role's permission keys sorted by code unit; empty when it has none or does not
   * exist.
   */
  async findPermissionKeys(roleId: string, tx?: Transaction): Promise<readonly string[]> {
    const grants = await selectExecutor(this.client, tx).rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true },
    });
    return grants.map((grant) => grant.permissionKey).sort();
  }
}
