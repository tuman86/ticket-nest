import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';

import { createIntegrationAuthApp } from '../../support/create-integration-auth-app';
import { type TestApp } from '../../support/create-test-app';
import { TestClock } from '../../support/test-clock';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { generateTestSigningKeys } from '../../support/test-signing-keys';

const PASSWORD = 'correct-horse-battery';
const EMAIL = 'lifecycle@example.com';

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
});

/**
 * @param accessToken - Token to present.
 * @returns The response of `GET /v1/users/me`.
 */
function getMe(accessToken: string): request.Test {
  return request(testApp.app).get('/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
}

describe('a whole session over HTTP, against Postgres', () => {
  it('login -> me -> refresh -> me -> logout -> refresh fails', async () => {
    await database.prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hasher.hash(PASSWORD),
        name: 'Test User',
        roleId: await database.findRoleId('CUSTOMER'),
      },
    });

    const login = await request(testApp.app)
      .post('/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const first = login.body as TokenPairBody;

    const meAfterLogin = await getMe(first.accessToken);
    expect(meAfterLogin.status).toBe(200);
    expect(meAfterLogin.body).toMatchObject({ email: EMAIL });

    const refreshed = await request(testApp.app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(refreshed.status).toBe(200);
    const second = refreshed.body as TokenPairBody;

    const meAfterRefresh = await getMe(second.accessToken);
    expect(meAfterRefresh.status).toBe(200);
    expect(meAfterRefresh.body).toMatchObject({ email: EMAIL });

    const loggedOut = await request(testApp.app)
      .post('/v1/auth/logout')
      .send({ refreshToken: second.refreshToken });
    expect(loggedOut.status).toBe(204);

    for (const refreshToken of [first.refreshToken, second.refreshToken]) {
      const afterLogout = await request(testApp.app)
        .post('/v1/auth/refresh')
        .send({ refreshToken });
      expect(afterLogout.status).toBe(401);
      expect(afterLogout.body).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    }
  });
});
