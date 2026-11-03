import { randomUUID } from 'node:crypto';

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
