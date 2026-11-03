import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';

import { createIntegrationAuthApp } from '../../support/create-integration-auth-app';
import { type TestApp } from '../../support/create-test-app';
import { mintAccessToken } from '../../support/mint-access-token';
import { TestClock } from '../../support/test-clock';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { generateTestSigningKeys, type TestSigningKeys } from '../../support/test-signing-keys';

const ME_PATH = '/v1/users/me';
const LOGIN_PATH = '/v1/auth/login';
const PASSWORD = 'correct-horse-battery';
const TENANT_ID = '5b1d2c3e-7f4a-4a6b-8c9d-0e1f2a3b4c5d';

let database: TestDatabase;
let keys: TestSigningKeys;
let clock: TestClock;
let testApp: TestApp;
const hasher = new Argon2idPasswordHasher();

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  keys = generateTestSigningKeys();
  clock = new TestClock();
  testApp = await createIntegrationAuthApp({ database, keys, clock, hasher });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
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
 * @returns An access token from a real login.
 */
async function loginForAccessToken(email: string): Promise<string> {
  const response = await request(testApp.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return (response.body as { accessToken: string }).accessToken;
}

/**
 * @param accessToken - Token to present.
 * @returns The response of `GET /v1/users/me`.
 */
function getMe(accessToken: string): request.Test {
  return request(testApp.app).get(ME_PATH).set('Authorization', `Bearer ${accessToken}`);
}

describe('GET /v1/users/me against Postgres', () => {
  it('returns the stored user without any secret field', async () => {
    const userId = await insertUser('me@example.com');
    const accessToken = await loginForAccessToken('me@example.com');

    const response = await getMe(accessToken);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      id: userId,
      email: 'me@example.com',
      status: 'ACTIVE',
      role: { key: 'CUSTOMER' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2/i);
  });

  it('shows the new role as soon as it changes in the database, with the same access token', async () => {
    const userId = await insertUser('promoted@example.com');
    const accessToken = await loginForAccessToken('promoted@example.com');
    expect((await getMe(accessToken)).body).toMatchObject({ role: { key: 'CUSTOMER' } });

    await database.prisma.user.update({
      where: { id: userId },
      data: { roleId: await database.findRoleId('OPERATOR'), tenantId: TENANT_ID },
    });

    const response = await getMe(accessToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ role: { key: 'OPERATOR' }, tenantId: TENANT_ID });
  });

  it('answers 401 once the user is DISABLED or deleted after the token was issued', async () => {
    const disabledId = await insertUser('disabled@example.com');
    const deletedId = await insertUser('deleted@example.com');
    const disabledToken = await loginForAccessToken('disabled@example.com');
    const deletedToken = await loginForAccessToken('deleted@example.com');
    await database.prisma.user.update({ where: { id: disabledId }, data: { status: 'DISABLED' } });
    await database.prisma.user.delete({ where: { id: deletedId } });

    const disabled = await getMe(disabledToken);
    const deleted = await getMe(deletedToken);

    for (const response of [disabled, deleted]) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('answers 401 for a correctly signed token whose user never existed', async () => {
    const token = await mintAccessToken({
      privateKey: keys.privateKey,
      issuedAt: clock.now(),
      subject: '0b9a4e6e-2c1d-4c7e-9f0a-1a2b3c4d5e6f',
    });

    expect((await getMe(token)).status).toBe(401);
  });
});
