import { createHash } from 'node:crypto';

import { jwtVerify } from 'jose';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { LoginService } from '@/auth/login.service';
import { RefreshService } from '@/auth/refresh.service';
import { RegisterService } from '@/auth/register.service';

import { createTestApp, type TestApp } from '../../support/create-test-app';
import { TestClock } from '../../support/test-clock';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from '../../support/test-signing-keys';

const LOGIN_PATH = '/v1/auth/login';
const REFRESH_PATH = '/v1/auth/refresh';
const PASSWORD = 'correct-horse-battery';
const REUSE_GRACE_MS = 10_000;
const PAST_GRACE_MS = REUSE_GRACE_MS + 1000;
const PARALLEL_REFRESHES = 10;
const TENANT_ID = '5b1d2c3e-7f4a-4a6b-8c9d-0e1f2a3b4c5d';

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
}

let database: TestDatabase;
/** A second, independent connection: sees only what has been committed. */
let observer: Pool;
let keys: TestSigningKeys;
let testApp: TestApp;
let clock: TestClock;
const hasher = new Argon2idPasswordHasher();

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  observer = new Pool({ connectionString: inject('databaseUrl') });
  keys = generateTestSigningKeys();
  clock = new TestClock();
  const tokenService = new EdDsaTokenService({
    privateKey: keys.privateKey,
    keyId: TEST_KEY_ID,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    now: clock.now,
  });
  const dummyPasswordHash = await hasher.hash('a password nobody knows');
  testApp = createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: hasher,
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: new LoginService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            passwordHasher: hasher,
            tokenService,
            dummyPasswordHash,
            logger,
            now: clock.now,
          }),
          refreshService: new RefreshService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            refreshTokenRepository: database.refreshTokenRepository,
            unitOfWork: database.unitOfWork,
            tokenService,
            reuseGraceMs: REUSE_GRACE_MS,
            logger,
            now: clock.now,
          }),
        }),
      ],
    },
  );
});

afterAll(async () => {
  await observer.end();
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
 * @returns The token pair from a fresh login.
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
 * @param refreshToken - A raw token value.
 * @returns Its stored row.
 */
async function findRow(refreshToken: string) {
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  return database.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash } });
}

/**
 * Counts, over the independent connection, the tokens of a family that are still not revoked.
 *
 * @param familyId - The family to look at.
 * @returns The number of tokens whose `revoked_at` is null, as committed data sees it.
 */
async function countUnrevokedAsSeenByObserver(familyId: string): Promise<number> {
  const result = await observer.query<{ count: string }>(
    'SELECT count(*) FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );
  return Number(result.rows[0]?.count);
}

describe('POST /v1/auth/refresh against Postgres', () => {
  it('rotates the token in one transaction: old row rotated and linked, new row in the same family', async () => {
    await insertUser('rotate@example.com');
    const pair = await login('rotate@example.com');
    const before = await findRow(pair.refreshToken);

    const response = await refresh(pair.refreshToken);

    expect(response.status).toBe(200);
    const next = (response.body as TokenPairBody).refreshToken;
    const oldRow = await findRow(pair.refreshToken);
    const newRow = await findRow(next);
    expect(oldRow).toMatchObject({ replacedById: newRow.id, revokedAt: null });
    expect(oldRow.rotatedAt).not.toBeNull();
    expect(newRow).toMatchObject({
      familyId: before.familyId,
      userId: before.userId,
      rotatedAt: null,
      revokedAt: null,
    });
    expect(newRow.authTime).toEqual(before.authTime);
    expect(newRow.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(newRow)).not.toContain(next);
  });

  describe('concurrency', () => {
    it('lets exactly one of several simultaneous refreshes succeed and does NOT revoke the family', async () => {
      await insertUser('race@example.com');
      const pair = await login('race@example.com');
      const { familyId } = await findRow(pair.refreshToken);

      const responses = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => refresh(pair.refreshToken)),
      );

      const succeeded = responses.filter((response) => response.status === 200);
      const failed = responses.filter((response) => response.status === 401);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(PARALLEL_REFRESHES - 1);
      const rows = await database.prisma.refreshToken.findMany({ where: { familyId } });
      // The original and one successor: every losing attempt rolled its new row back.
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(0);
      expect(rows.filter((row) => row.rotatedAt === null)).toHaveLength(1);
      const winner = (succeeded[0]?.body as TokenPairBody).refreshToken;
      expect((await refresh(winner)).status).toBe(200);
    });

    it('gives every loser the same 401 as any other refresh failure', async () => {
      await insertUser('race-body@example.com');
      const pair = await login('race-body@example.com');

      const responses = await Promise.all(
        Array.from({ length: PARALLEL_REFRESHES }, () => refresh(pair.refreshToken)),
      );

      for (const response of responses.filter((candidate) => candidate.status !== 200)) {
        expect(response.body).toMatchObject({
          status: 401,
          code: 'INVALID_REFRESH_TOKEN',
          detail: 'Invalid refresh token.',
        });
      }
    });
  });

  describe('reuse detection', () => {
    it('commits the family revocation before the 401 is answered, as another connection sees it', async () => {
      await insertUser('reuse@example.com');
      const pair = await login('reuse@example.com');
      const next = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const { familyId } = await findRow(pair.refreshToken);
      // The rotated token and its live successor: neither is revoked yet.
      expect(await countUnrevokedAsSeenByObserver(familyId)).toBe(2);
      clock.advance(PAST_GRACE_MS);

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      expect(await countUnrevokedAsSeenByObserver(familyId)).toBe(0);
      expect((await refresh(next.refreshToken)).status).toBe(401);
    });

    it('does not revoke the family for a replay inside the grace window', async () => {
      await insertUser('grace@example.com');
      const pair = await login('grace@example.com');
      const next = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const { familyId } = await findRow(pair.refreshToken);

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      expect(await countUnrevokedAsSeenByObserver(familyId)).toBe(2);
      expect((await refresh(next.refreshToken)).status).toBe(200);
    });

    it('gives a replay on an already revoked family a plain 401 and revokes nothing more', async () => {
      await insertUser('revoked@example.com');
      const pair = await login('revoked@example.com');
      await refresh(pair.refreshToken);
      const { familyId } = await findRow(pair.refreshToken);
      await database.unitOfWork.run((tx) =>
        database.refreshTokenRepository.revokeFamily(
          familyId,
          new Date('2026-01-01T00:00:00Z'),
          tx,
        ),
      );
      testApp.lines.length = 0;

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      const revokedAt = await database.prisma.refreshToken.findMany({
        where: { familyId },
        select: { revokedAt: true },
      });
      for (const row of revokedAt) {
        expect(row.revokedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      }
      expect(
        testApp.lines.filter((line) => line.msg === 'refresh token reuse detected'),
      ).toHaveLength(0);
    });

    it('leaves another user and another family of the same user alone', async () => {
      await insertUser('victim@example.com');
      await insertUser('bystander@example.com');
      const victim = await login('victim@example.com');
      const victimOtherDevice = await login('victim@example.com');
      const bystander = await login('bystander@example.com');
      await refresh(victim.refreshToken);
      clock.advance(PAST_GRACE_MS);

      await refresh(victim.refreshToken);

      expect((await refresh(bystander.refreshToken)).status).toBe(200);
      expect((await refresh(victimOtherDevice.refreshToken)).status).toBe(200);
    });
  });

  describe('data read at refresh time', () => {
    it('takes role and tenant from the database, so a role change applies at the next refresh', async () => {
      const userId = await insertUser('promoted@example.com');
      const pair = await login('promoted@example.com');
      await database.prisma.user.update({
        where: { id: userId },
        data: { roleId: await database.findRoleId('OPERATOR'), tenantId: TENANT_ID },
      });

      const response = await refresh(pair.refreshToken);

      const { payload } = await jwtVerify(
        (response.body as TokenPairBody).accessToken,
        keys.publicKey,
        { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, currentDate: clock.now() },
      );
      expect(payload).toMatchObject({ sub: userId, role: 'OPERATOR', tenantId: TENANT_ID });
      const old = await jwtVerify(pair.accessToken, keys.publicKey, { currentDate: clock.now() });
      expect(old.payload).toMatchObject({ role: 'CUSTOMER' });
    });

    it('refuses a user who was disabled after login and leaves the token unrotated', async () => {
      const userId = await insertUser('disabled@example.com');
      const pair = await login('disabled@example.com');
      await database.prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });

      const response = await refresh(pair.refreshToken);

      expect(response.status).toBe(401);
      expect((await findRow(pair.refreshToken)).rotatedAt).toBeNull();
    });

    it('keeps authTime fixed down the chain and never lets a family pass 30 days', async () => {
      await insertUser('cap@example.com');
      const pair = await login('cap@example.com');
      const first = await findRow(pair.refreshToken);
      let token = pair.refreshToken;
      for (let step = 0; step < 4; step += 1) {
        clock.advance(6 * 24 * 60 * 60 * 1000);
        token = ((await refresh(token)).body as TokenPairBody).refreshToken;
      }
      clock.advance(5 * 24 * 60 * 60 * 1000);

      const response = await refresh(token);

      const last = await findRow((response.body as TokenPairBody).refreshToken);
      expect(last.authTime).toEqual(first.authTime);
      expect(last.expiresAt.getTime()).toBe(first.authTime.getTime() + 30 * 24 * 60 * 60 * 1000);
      clock.advance(2 * 24 * 60 * 60 * 1000);
      expect((await refresh((response.body as TokenPairBody).refreshToken)).status).toBe(401);
    });
  });

  describe('secrets', () => {
    it('leaves no raw token or token hash in any log line', async () => {
      await insertUser('logs@example.com');
      const pair = await login('logs@example.com');
      testApp.lines.length = 0;

      const next = (await refresh(pair.refreshToken)).body as TokenPairBody;
      await refresh(pair.refreshToken);
      clock.advance(PAST_GRACE_MS);
      await refresh(pair.refreshToken);

      const logged = JSON.stringify(testApp.lines);
      const hashes = (await database.prisma.refreshToken.findMany()).map((row) => row.tokenHash);
      for (const secret of [pair.refreshToken, next.refreshToken, next.accessToken, ...hashes]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
