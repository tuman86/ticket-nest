import { createHash } from 'node:crypto';

import { jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { LoginService } from '@/auth/login.service';
import { parseArgon2idPhc } from '@/auth/phc-string';
import { RegisterService } from '@/auth/register.service';

import { createUnusedRefreshService } from '../../support/create-unused-auth-services';
import { createTestApp, type TestApp } from '../../support/create-test-app';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from '../../support/test-signing-keys';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const LOGIN_PATH = '/v1/auth/login';
const PASSWORD = 'correct-horse-battery';
const RAISED_MEMORY_KIB = 32 * 1024;

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
}

let database: TestDatabase;
let keys: TestSigningKeys;
let testApp: TestApp;
let currentHasher: Argon2idPasswordHasher;
const legacyHasher = new Argon2idPasswordHasher();

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  keys = generateTestSigningKeys();
  // The service hashes with stronger parameters than `legacyHasher`, so stored hashes look old.
  currentHasher = new Argon2idPasswordHasher({ memoryKib: RAISED_MEMORY_KIB });
  const dummyPasswordHash = await currentHasher.hash('a password nobody knows');
  testApp = createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: currentHasher,
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: new LoginService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: currentHasher,
            tokenService: new EdDsaTokenService({
              privateKey: keys.privateKey,
              keyId: TEST_KEY_ID,
              issuer: TEST_ISSUER,
              audience: TEST_AUDIENCE,
            }),
            dummyPasswordHash,
            logger,
          }),
          refreshService: createUnusedRefreshService(logger),
        }),
      ],
    },
  );
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
});

/**
 * @param email - Normalized email of the new user.
 * @param overrides - Fields to change: status, tenant, role key.
 * @returns The stored user id and its (old-parameter) password hash.
 */
async function insertUser(
  email: string,
  overrides: { status?: 'ACTIVE' | 'DISABLED'; roleKey?: string; tenantId?: string } = {},
): Promise<{ id: string; passwordHash: string }> {
  const passwordHash = await legacyHasher.hash(PASSWORD);
  const user = await database.prisma.user.create({
    data: {
      email,
      passwordHash,
      name: 'Test User',
      roleId: await database.findRoleId(overrides.roleKey ?? 'CUSTOMER'),
      status: overrides.status ?? 'ACTIVE',
      tenantId: overrides.tenantId ?? null,
    },
  });
  return { id: user.id, passwordHash };
}

describe('POST /v1/auth/login against Postgres', () => {
  it('logs in a user created through register', async () => {
    await request(testApp.app)
      .post('/v1/auth/register')
      .send({ email: 'Registered@Example.com', password: PASSWORD, name: 'Reg User' });

    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email: ' registered@example.COM ', password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it('stores the SHA-256 hash of the refresh token and never the token', async () => {
    const user = await insertUser('stored@example.com');

    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .set('User-Agent', 'integration-agent')
      .send({ email: 'stored@example.com', password: PASSWORD });

    const { refreshToken } = response.body as TokenPairBody;
    const rows = await database.prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(refreshToken).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(refreshToken);
    expect(rows[0]).toMatchObject({ userAgent: 'integration-agent', revokedAt: null });
    expect(rows[0]?.ip).not.toBeNull();
  });

  it('issues a token whose claims come from the stored user, role and tenant', async () => {
    const tenantId = '5b1d2c3e-7f4a-4a6b-8c9d-0e1f2a3b4c5d';
    const user = await insertUser('operator@example.com', { roleKey: 'OPERATOR', tenantId });

    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email: 'operator@example.com', password: PASSWORD });

    const { payload } = await jwtVerify(
      (response.body as TokenPairBody).accessToken,
      keys.publicKey,
      { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, algorithms: ['EdDSA'] },
    );
    expect(payload).toMatchObject({ sub: user.id, role: 'OPERATOR', tenantId, permissions: [] });
    const row = await database.prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(payload).toMatchObject({ auth_time: Math.floor(row.authTime.getTime() / 1000) });
  });

  it('creates a separate family for each login of the same user', async () => {
    const user = await insertUser('twice@example.com');

    await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email: 'twice@example.com', password: PASSWORD });
    await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email: 'twice@example.com', password: PASSWORD });

    const rows = await database.prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.familyId)).size).toBe(2);
  });

  it('persists the upgraded password hash together with the token row', async () => {
    const user = await insertUser('upgrade@example.com');
    expect(parseArgon2idPhc(user.passwordHash)?.memoryKib).toBeLessThan(RAISED_MEMORY_KIB);

    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email: 'upgrade@example.com', password: PASSWORD });

    expect(response.status).toBe(200);
    const stored = await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(parseArgon2idPhc(stored.passwordHash ?? '')?.memoryKib).toBe(RAISED_MEMORY_KIB);
    expect(await currentHasher.verify(PASSWORD, stored.passwordHash ?? '')).toBe(true);
    expect(await database.prisma.refreshToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it.each([
    ['a wrong password', 'wrong@example.com', 'not-the-password'],
    ['an unknown email', 'nobody@example.com', PASSWORD],
    ['a disabled user', 'disabled@example.com', PASSWORD],
  ])('answers %s with the same 401 and stores nothing', async (_name, email, password) => {
    await insertUser('wrong@example.com');
    const disabled = await insertUser('disabled@example.com', { status: 'DISABLED' });

    const response = await request(testApp.app).post(LOGIN_PATH).send({ email, password });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      detail: 'Invalid email or password.',
    });
    expect(await database.prisma.refreshToken.count()).toBe(0);
    const stored = await database.prisma.user.findUniqueOrThrow({ where: { id: disabled.id } });
    expect(stored.passwordHash).toBe(disabled.passwordHash);
  });
});
