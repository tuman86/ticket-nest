import { createHash } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';

import { createIntegrationAuthApp } from '../../support/create-integration-auth-app';
import { type TestApp } from '../../support/create-test-app';
import { TestClock } from '../../support/test-clock';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { generateTestSigningKeys } from '../../support/test-signing-keys';

const LOGIN_PATH = '/v1/auth/login';
const REFRESH_PATH = '/v1/auth/refresh';
const LOGOUT_PATH = '/v1/auth/logout';
const PASSWORD = 'correct-horse-battery';
const PARALLEL_LOGOUTS = 8;

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
}

let database: TestDatabase;
let testApp: TestApp;
const hasher = new Argon2idPasswordHasher();

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  testApp = await createIntegrationAuthApp({
    database,
    keys: generateTestSigningKeys(),
    clock: new TestClock(),
    hasher,
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
  testApp.lines.length = 0;
});

/**
 * @param email - Normalized email of the new user.
 * @returns The stored user's id.
 */
async function insertUser(email: string): Promise<string> {
  const user = await database.prisma.user.create({
    data: {
      email,
      passwordHash: await hasher.hash(PASSWORD),
      name: 'Test User',
      roleId: await database.findRoleId('CUSTOMER'),
    },
  });
  return user.id;
}

/**
 * @param email - The user's email.
 * @returns The token pair from a fresh login (a new family).
 */
async function login(email: string): Promise<TokenPairBody> {
  const response = await request(testApp.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return response.body as TokenPairBody;
}

/**
 * @param refreshToken - The raw token to present.
 * @returns The response.
 */
function refresh(refreshToken: string): request.Test {
  return request(testApp.app).post(REFRESH_PATH).send({ refreshToken });
}

/**
 * @param refreshToken - The raw token to present.
 * @returns The response.
 */
function logout(refreshToken: string): request.Test {
  return request(testApp.app).post(LOGOUT_PATH).send({ refreshToken });
}

/**
 * @param refreshToken - A raw token value.
 * @returns Its stored row.
 */
async function findRow(refreshToken: string) {
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  return database.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash } });
}

/**
 * @returns Every stored refresh token row, in a stable order, for before/after comparisons.
 */
async function snapshotRows() {
  return database.prisma.refreshToken.findMany({ orderBy: { id: 'asc' } });
}

describe('POST /v1/auth/logout against Postgres', () => {
  it('sets revokedAt on every row of the family in the database and ends the session', async () => {
    await insertUser('family@example.com');
    const first = await login('family@example.com');
    const second = (await refresh(first.refreshToken)).body as TokenPairBody;
    const third = (await refresh(second.refreshToken)).body as TokenPairBody;
    const { familyId } = await findRow(first.refreshToken);

    const response = await logout(third.refreshToken);

    expect(response.status).toBe(204);
    const rows = await database.prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await refresh(third.refreshToken)).status).toBe(401);
  });

  it('revokes the whole family when the oldest, already rotated token is presented', async () => {
    await insertUser('old@example.com');
    const first = await login('old@example.com');
    const second = (await refresh(first.refreshToken)).body as TokenPairBody;
    const { familyId } = await findRow(first.refreshToken);

    const response = await logout(first.refreshToken);

    expect(response.status).toBe(204);
    const rows = await database.prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await refresh(second.refreshToken)).status).toBe(401);
  });

  it('changes nothing in the database for an unknown or malformed token', async () => {
    await insertUser('unknown@example.com');
    await login('unknown@example.com');
    const before = await snapshotRows();

    for (const token of ['never-issued', 'x', 'a'.repeat(128)]) {
      expect((await logout(token)).status).toBe(204);
    }

    expect(await snapshotRows()).toEqual(before);
  });

  it('changes nothing for a token whose family is already revoked, and keeps the old revokedAt', async () => {
    await insertUser('revoked@example.com');
    const pair = await login('revoked@example.com');
    await logout(pair.refreshToken);
    const before = await snapshotRows();

    const response = await logout(pair.refreshToken);

    expect(response.status).toBe(204);
    expect(await snapshotRows()).toEqual(before);
  });

  it('leaves another family of the same user and another user untouched', async () => {
    await insertUser('mine@example.com');
    await insertUser('theirs@example.com');
    const mine = await login('mine@example.com');
    const myOtherDevice = await login('mine@example.com');
    const theirs = await login('theirs@example.com');
    const others = [myOtherDevice.refreshToken, theirs.refreshToken];
    const othersBefore = await Promise.all(others.map((token) => findRow(token)));

    await logout(mine.refreshToken);

    expect(await Promise.all(others.map((token) => findRow(token)))).toEqual(othersBefore);
    for (const token of others) {
      expect((await refresh(token)).status).toBe(200);
    }
  });

  it('is safe to run concurrently with itself: every call answers 204 and the family ends revoked', async () => {
    await insertUser('parallel@example.com');
    const pair = await login('parallel@example.com');
    const { familyId } = await findRow(pair.refreshToken);

    const responses = await Promise.all(
      Array.from({ length: PARALLEL_LOGOUTS }, () => logout(pair.refreshToken)),
    );

    expect(responses.map((response) => response.status)).toEqual(Array(PARALLEL_LOGOUTS).fill(204));
    const rows = await database.prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('logs no raw token or hash', async () => {
    await insertUser('logs@example.com');
    const pair = await login('logs@example.com');
    const { tokenHash } = await findRow(pair.refreshToken);

    await logout(pair.refreshToken);

    const everything = JSON.stringify(testApp.lines);
    expect(everything).not.toContain(pair.refreshToken);
    expect(everything).not.toContain(tokenHash);
  });
});
