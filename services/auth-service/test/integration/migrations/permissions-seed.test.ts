import { randomUUID } from 'node:crypto';

import { PERMISSION_CATALOGUE } from '@ticketnest/contracts';
import { readGrantMatrix } from '@ticketnest/contracts/testing';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const ADMIN_ROLE_KEY = 'ADMIN';
const BUILT_IN_ROLE_KEYS = ['ADMIN', 'CUSTOMER', 'OPERATOR', 'SUPPORT_AGENT'];
const TENANT_BOUND_ROLE_KEYS = ['OPERATOR'];

let database: TestDatabase;

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.close();
});

/**
 * Runs a statement that must be refused, inside a transaction that is always rolled back, so a
 * test that wrongly succeeds cannot leave a bad row in the shared reference data.
 *
 * @param sql - The statement.
 * @param parameters - Its parameters.
 * @returns The error Postgres raised.
 * @throws Error when the statement succeeds.
 */
async function expectRefusal(sql: string, parameters: readonly unknown[] = []): Promise<Error> {
  const client: PoolClient = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, [...parameters]);
    throw new Error(`The statement was accepted: ${sql}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The statement was accepted')) {
      throw error;
    }
    return error as Error;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('the permission catalogue seed', () => {
  it('holds exactly the keys and descriptions of PERMISSION_CATALOGUE', async () => {
    const { rows } = await database.pool.query<{ key: string; description: string }>(
      'SELECT key, description FROM permissions',
    );

    const stored = rows.map(({ key, description }) => [key, description]).sort();
    const expected = PERMISSION_CATALOGUE.map(({ key, description }) => [key, description]).sort();
    expect(stored).toEqual(expected);
  });
});

describe('the default grants seed', () => {
  /**
   * @returns Each built-in role's seeded keys, sorted, read straight from the tables.
   */
  async function readSeededGrants(): Promise<Record<string, string[]>> {
    const { rows } = await database.pool.query<{ role_key: string; permission_key: string | null }>(
      `SELECT r.key AS role_key, rp.permission_key
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.is_system`,
    );
    const grants: Record<string, string[]> = {};
    for (const { role_key: roleKey, permission_key: permissionKey } of rows) {
      (grants[roleKey] ??= []).push(...(permissionKey === null ? [] : [permissionKey]));
    }
    return Object.fromEntries(Object.entries(grants).map(([role, keys]) => [role, keys.sort()]));
  }

  it('seeds the four built-in roles', async () => {
    expect(Object.keys(await readSeededGrants()).sort()).toEqual(BUILT_IN_ROLE_KEYS);
  });

  it('gives each role its confirmed grants from docs/permissions.md, plus the assumed ones for ADMIN only', async () => {
    const matrix = readGrantMatrix();
    const grants = await readSeededGrants();

    for (const role of matrix.roleKeys) {
      const confirmed = matrix.confirmed[role] ?? [];
      const assumed = role === ADMIN_ROLE_KEY ? (matrix.assumed[role] ?? []) : [];
      expect(grants[role], role).toEqual([...confirmed, ...assumed].sort());
    }
  });

  it('withholds every unconfirmed grant from the roles other than ADMIN', async () => {
    const matrix = readGrantMatrix();
    const grants = await readSeededGrants();
    const withheld = matrix.roleKeys
      .filter((role) => role !== ADMIN_ROLE_KEY)
      .flatMap((role) => (matrix.assumed[role] ?? []).map((key) => ({ role, key })));

    expect(withheld.length).toBeGreaterThan(0);
    for (const { role, key } of withheld) {
      expect(grants[role], `${role} must not hold ${key}`).not.toContain(key);
    }
  });

  it('gives CUSTOMER no permission at all', async () => {
    expect((await readSeededGrants()).CUSTOMER).toEqual([]);
  });

  it('marks OPERATOR, and no other built-in role, as tenant-bound', async () => {
    const { rows } = await database.pool.query<{ key: string }>(
      'SELECT key FROM roles WHERE tenant_bound AND is_system ORDER BY key',
    );

    expect(rows.map((row) => row.key)).toEqual(TENANT_BOUND_ROLE_KEYS);
  });
});

describe('the permission tables refuse bad data', () => {
  it.each([
    ['upper case', 'Role:Manage'],
    ['no action', 'rolemanage'],
    ['four segments', 'a:b:c:d'],
    ['a digit', 'role:manage2'],
    ['an empty resource', ':manage'],
    ['a trailing colon', 'role:manage:'],
    ['a space', 'role: manage'],
  ])('rejects a key with %s through permissions_key_format_check', async (_name, key) => {
    const error = await expectRefusal(
      "INSERT INTO permissions (key, description) VALUES ($1, 'x')",
      [key],
    );

    expect(error.message).toContain('permissions_key_format_check');
  });

  it('accepts a well-formed key, so the check is not simply refusing everything', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        "INSERT INTO permissions (key, description) VALUES ('booking:hold:own', 'x')",
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a grant of a key the catalogue does not hold', async () => {
    const error = await expectRefusal(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT id, 'nope:nope' FROM roles WHERE key = 'CUSTOMER'`,
    );

    expect(error.message).toContain('role_permissions_permission_key_fkey');
  });

  it('rejects the same grant twice', async () => {
    const error = await expectRefusal(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT id, 'inventory:read' FROM roles WHERE key = 'OPERATOR'`,
    );

    expect(error.message).toContain('role_permissions_pkey');
  });

  it('refuses to delete or rename a permission that a role holds', async () => {
    const deletion = await expectRefusal("DELETE FROM permissions WHERE key = 'inventory:read'");
    const rename = await expectRefusal(
      "UPDATE permissions SET key = 'inventory:view' WHERE key = 'inventory:read'",
    );

    expect(deletion.message).toContain('role_permissions_permission_key_fkey');
    expect(rename.message).toContain('role_permissions_permission_key_fkey');
  });

  it('removes the grants of a role together with the role', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const key = `CUSTOM_${randomUUID()}`;
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO roles (key, name, updated_at) VALUES ($1, 'Custom', now()) RETURNING id",
        [key],
      );
      const roleId = rows[0]?.id;
      await client.query(
        "INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'inventory:read')",
        [roleId],
      );

      await client.query('DELETE FROM roles WHERE id = $1', [roleId]);

      const left = await client.query('SELECT 1 FROM role_permissions WHERE role_id = $1', [
        roleId,
      ]);
      expect(left.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
