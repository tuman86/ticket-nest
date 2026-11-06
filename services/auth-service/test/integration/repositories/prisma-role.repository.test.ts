import { randomUUID } from 'node:crypto';

import { PERMISSION_KEYS } from '@ticketnest/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.close();
});

describe('PrismaRoleRepository.findById', () => {
  it('finds a built-in role by its id and returns only the id, key and name', async () => {
    const id = await database.findRoleId('OPERATOR');

    const role = await database.roleRepository.findById(id);

    expect(role).toEqual({ id, key: 'OPERATOR', name: 'Operator' });
  });

  it('returns null for an unknown id', async () => {
    expect(await database.roleRepository.findById(randomUUID())).toBeNull();
  });

  it('reads inside a transaction when given one', async () => {
    const id = await database.findRoleId('ADMIN');

    const role = await database.unitOfWork.run((tx) => database.roleRepository.findById(id, tx));

    expect(role?.key).toBe('ADMIN');
  });
});

describe('PrismaRoleRepository.findByKey', () => {
  it('finds a built-in role by its key', async () => {
    const role = await database.roleRepository.findByKey('CUSTOMER');

    expect(role).toEqual({
      id: await database.findRoleId('CUSTOMER'),
      key: 'CUSTOMER',
      name: 'Customer',
    });
  });

  it('returns only the id, key and name', async () => {
    const role = await database.roleRepository.findByKey('ADMIN');

    expect(Object.keys(role ?? {}).sort()).toEqual(['id', 'key', 'name']);
  });

  it('returns null for an unknown key and does not match by letter case', async () => {
    expect(await database.roleRepository.findByKey('NOPE')).toBeNull();
    expect(await database.roleRepository.findByKey('customer')).toBeNull();
  });

  it('reads inside a transaction when given one', async () => {
    const role = await database.unitOfWork.run((tx) =>
      database.roleRepository.findByKey('OPERATOR', tx),
    );

    expect(role?.key).toBe('OPERATOR');
  });
});

describe('PrismaRoleRepository.findPermissionKeys', () => {
  /** Keys inserted out of order, and with a prefix that sorts differently by code unit and by locale. */
  const UNSORTED_KEYS = ['user:read:tenant', 'user:manage', 'inventory:read', 'user:read:any'];
  const createdRoleIds: string[] = [];

  afterAll(async () => {
    await database.prisma.role.deleteMany({ where: { id: { in: createdRoleIds } } });
  });

  /**
   * @param keys - Permission keys the new role holds.
   * @returns The id of a custom role holding exactly those keys.
   */
  async function createRoleWith(keys: readonly string[]): Promise<string> {
    const role = await database.prisma.role.create({
      data: {
        key: `CUSTOM_${randomUUID()}`,
        name: 'Custom',
        permissions: { create: keys.map((permissionKey) => ({ permissionKey })) },
      },
    });
    createdRoleIds.push(role.id);
    return role.id;
  }

  it("returns a role's keys sorted by code unit, whatever order they were granted in", async () => {
    const id = await createRoleWith(UNSORTED_KEYS);

    expect(await database.roleRepository.findPermissionKeys(id)).toEqual([
      'inventory:read',
      'user:manage',
      'user:read:any',
      'user:read:tenant',
    ]);
  });

  it('returns every catalogue key for ADMIN, in the same order', async () => {
    const id = await database.findRoleId('ADMIN');

    expect(await database.roleRepository.findPermissionKeys(id)).toEqual(
      [...PERMISSION_KEYS].sort(),
    );
  });

  it('returns an empty list for a role with no grants and for an unknown role', async () => {
    const customerId = await database.findRoleId('CUSTOMER');

    expect(await database.roleRepository.findPermissionKeys(customerId)).toEqual([]);
    expect(await database.roleRepository.findPermissionKeys(randomUUID())).toEqual([]);
  });

  it('returns only the keys of the role asked for', async () => {
    const id = await createRoleWith(['inventory:read']);

    expect(await database.roleRepository.findPermissionKeys(id)).toEqual(['inventory:read']);
  });

  it('reads inside a transaction when given one', async () => {
    const id = await createRoleWith(['fee:manage']);

    const keys = await database.unitOfWork.run((tx) =>
      database.roleRepository.findPermissionKeys(id, tx),
    );

    expect(keys).toEqual(['fee:manage']);
  });
});
