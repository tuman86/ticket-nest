import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { jwtVerify } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { hashRefreshToken } from '@/auth/refresh-token-hash';
import { REFRESH_ABSOLUTE_TTL_MS, REFRESH_IDLE_TTL_MS } from '@/auth/token-constants';
import { type RefreshTokenRecord } from '@/repositories/refresh-token.repository';

import {
  createAuthTestApp,
  DEFAULT_TEST_REUSE_GRACE_MS,
  type AuthTestApp,
} from '../../support/create-auth-test-app';
import { TEST_AUDIENCE, TEST_ISSUER } from '../../support/test-signing-keys';

const LOGIN_PATH = '/v1/auth/login';
const REFRESH_PATH = '/v1/auth/refresh';
const PASSWORD = 'correct-horse-battery';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5_000;
const PAST_GRACE_MS = DEFAULT_TEST_REUSE_GRACE_MS + 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REUSE_LOG_MESSAGE = 'refresh token reuse detected';
const GRACE_LOG_MESSAGE = 'refresh replay inside grace window';

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

/**
 * @param value - A problem body.
 * @returns The body without `correlationId`, so two bodies from different requests compare equal.
 */
function withoutCorrelationId(value: unknown): unknown {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'correlationId'),
  );
}

describe('POST /v1/auth/refresh', () => {
  let testApp: AuthTestApp;
  let emailCounter = 0;

  beforeAll(async () => {
    testApp = await createAuthTestApp();
  });

  /**
   * @returns A unique email, so tests do not share users.
   */
  function nextEmail(): string {
    emailCounter += 1;
    return `refresh-${String(emailCounter)}@example.com`;
  }

  /**
   * Creates a user and logs them in.
   *
   * @param status - Account status of the new user.
   * @returns The user id and the login's token pair.
   */
  async function loginNewUser(
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ): Promise<{ userId: string; email: string; pair: TokenPairBody }> {
    const email = nextEmail();
    const user = await testApp.addUser({ email, password: PASSWORD });
    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email, password: PASSWORD });
    if (status === 'DISABLED') {
      await testApp.users.updateStatus(user.id, 'DISABLED');
    }
    return { userId: user.id, email, pair: response.body as TokenPairBody };
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
   * @returns The stored row for it.
   */
  async function findRow(refreshToken: string): Promise<RefreshTokenRecord> {
    const row = await testApp.refreshTokens.findByTokenHash(hashRefreshToken(refreshToken));
    if (row === null) {
      throw new Error('expected a stored refresh token');
    }
    return row;
  }

  /**
   * Inserts a refresh token directly, to set up states a normal login cannot reach quickly.
   *
   * @param userId - Owner of the token.
   * @param overrides - Fields to change from an ordinary fresh token.
   * @returns The raw token and its row.
   */
  async function seedToken(
    userId: string,
    overrides: { authTime?: Date; expiresAt?: Date; isRevoked?: boolean } = {},
  ): Promise<{ value: string; record: RefreshTokenRecord }> {
    const now = testApp.clock.now();
    const value = randomBytes(32).toString('base64url');
    const record = await testApp.refreshTokens.create({
      userId,
      familyId: randomUUID(),
      tokenHash: hashRefreshToken(value),
      authTime: overrides.authTime ?? now,
      expiresAt: overrides.expiresAt ?? new Date(now.getTime() + REFRESH_IDLE_TTL_MS),
      userAgent: null,
      ip: null,
    });
    if (overrides.isRevoked === true) {
      await testApp.refreshTokens.revokeFamily(record.familyId, now);
    }
    return { value, record };
  }

  /**
   * @param message - A log message.
   * @returns The collected log lines with that message.
   */
  function logLines(message: string): Record<string, unknown>[] {
    return testApp.lines.filter((line) => line.msg === message);
  }

  describe('on success', () => {
    it('answers 200 with a new token pair in the same shape as login', async () => {
      const { pair } = await loginNewUser();

      const response = await refresh(pair.refreshToken);

      const body = response.body as TokenPairBody;
      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(
        ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType'].sort(),
      );
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(600);
      expect(body.refreshExpiresIn).toBe(REFRESH_IDLE_TTL_MS / 1000);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(body.refreshToken).not.toBe(pair.refreshToken);
      expect(body.accessToken).not.toBe(pair.accessToken);
    });

    it('issues a valid access token that keeps the original auth_time', async () => {
      const { userId, pair } = await loginNewUser();
      const first = await jwtVerify(pair.accessToken, testApp.keys.publicKey);
      testApp.clock.advance(60_000);

      const response = await refresh(pair.refreshToken);

      const { payload } = await jwtVerify(
        (response.body as TokenPairBody).accessToken,
        testApp.keys.publicKey,
        {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          algorithms: ['EdDSA'],
          currentDate: testApp.clock.now(),
        },
      );
      expect(payload.sub).toBe(userId);
      expect(payload).toMatchObject({ role: 'CUSTOMER', permissions: [] });
      expect(payload.jti).toMatch(UUID_PATTERN);
      expect(payload.jti).not.toBe(first.payload.jti);
      expect(payload.exp).toBe((payload.iat ?? 0) + 600);
      expect(payload.iat).toBeGreaterThan(first.payload.iat ?? 0);
      expect(payload).toMatchObject({ auth_time: first.payload.auth_time });
    });

    it('marks the old token rotated and links it to the new one, in the same family', async () => {
      const { pair } = await loginNewUser();
      const before = await findRow(pair.refreshToken);

      const response = await refresh(pair.refreshToken);

      const newToken = (response.body as TokenPairBody).refreshToken;
      const oldRow = await findRow(pair.refreshToken);
      const newRow = await findRow(newToken);
      expect(oldRow.rotatedAt).not.toBeNull();
      expect(oldRow.replacedById).toBe(newRow.id);
      expect(oldRow.revokedAt).toBeNull();
      expect(newRow.familyId).toBe(before.familyId);
      expect(newRow.userId).toBe(before.userId);
      expect(newRow.rotatedAt).toBeNull();
      expect(newRow.revokedAt).toBeNull();
    });

    it('stores only the SHA-256 hash of the new token, with this request details', async () => {
      const { pair } = await loginNewUser();

      const response = await request(testApp.app)
        .post(REFRESH_PATH)
        .set('User-Agent', 'refresh-agent')
        .send({ refreshToken: pair.refreshToken });

      const newToken = (response.body as TokenPairBody).refreshToken;
      const row = await findRow(newToken);
      expect(row.tokenHash).toBe(createHash('sha256').update(newToken).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(newToken);
      expect(row.userAgent).toBe('refresh-agent');
      expect(row.ip).not.toBeNull();
    });

    it('copies authTime to the successor and renews the idle expiry', async () => {
      const { pair } = await loginNewUser();
      const before = await findRow(pair.refreshToken);
      testApp.clock.advance(2 * DAY_MS);

      const response = await refresh(pair.refreshToken);

      const row = await findRow((response.body as TokenPairBody).refreshToken);
      expect(row.authTime).toEqual(before.authTime);
      const expectedExpiry = testApp.clock.now().getTime() + REFRESH_IDLE_TTL_MS;
      expect(Math.abs(row.expiresAt.getTime() - expectedExpiry)).toBeLessThan(CLOCK_TOLERANCE_MS);
    });

    it('lets the new token be refreshed again', async () => {
      const { pair } = await loginNewUser();
      const first = await refresh(pair.refreshToken);

      const second = await refresh((first.body as TokenPairBody).refreshToken);

      expect(second.status).toBe(200);
    });

    it('never extends a session past 30 days from login', async () => {
      const { pair } = await loginNewUser();
      const login = await findRow(pair.refreshToken);
      const limit = login.authTime.getTime() + REFRESH_ABSOLUTE_TTL_MS;
      let token = pair.refreshToken;
      for (let step = 0; step < 4; step += 1) {
        testApp.clock.advance(6 * DAY_MS);
        token = ((await refresh(token)).body as TokenPairBody).refreshToken;
      }
      testApp.clock.advance(5 * DAY_MS);

      const response = await refresh(token);

      const body = response.body as TokenPairBody;
      const row = await findRow(body.refreshToken);
      expect(response.status).toBe(200);
      expect(row.expiresAt.getTime()).toBe(limit);
      expect(row.authTime).toEqual(login.authTime);
      expect(body.refreshExpiresIn).toBe(
        Math.floor((limit - testApp.clock.now().getTime()) / 1000),
      );
      expect(body.refreshExpiresIn).toBeLessThan(REFRESH_IDLE_TTL_MS / 1000);
    });
  });

  describe('the old token', () => {
    it('no longer works after it was rotated', async () => {
      const { pair } = await loginNewUser();
      await refresh(pair.refreshToken);

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
    });
  });

  describe('failures', () => {
    it('answers every failure with the same 401 problem', async () => {
      const active = await loginNewUser();
      const reused = await loginNewUser();
      const reusedSecond = await refresh(reused.pair.refreshToken);
      expect(reusedSecond.status).toBe(200);
      testApp.clock.advance(PAST_GRACE_MS);
      const disabled = await loginNewUser('DISABLED');
      const revoked = await seedToken(active.userId, { isRevoked: true });
      const expired = await seedToken(active.userId, {
        expiresAt: new Date(testApp.clock.now().getTime() - 1000),
      });
      const sessionEnded = await seedToken(active.userId, {
        authTime: new Date(testApp.clock.now().getTime() - REFRESH_ABSOLUTE_TTL_MS - DAY_MS),
      });
      const inGrace = await loginNewUser();
      await refresh(inGrace.pair.refreshToken);

      const attempts: [string, string][] = [
        ['an unknown token', randomBytes(32).toString('base64url')],
        ['a revoked token', revoked.value],
        ['an expired token', expired.value],
        ['a token past the absolute session limit', sessionEnded.value],
        ['a token of a disabled user', disabled.pair.refreshToken],
        ['a reused token outside the grace window', reused.pair.refreshToken],
        ['a replay inside the grace window', inGrace.pair.refreshToken],
      ];
      const responses = await Promise.all(
        attempts.map(async ([name, token]) => ({ name, response: await refresh(token) })),
      );

      for (const { response } of responses) {
        expect(response.status).toBe(401);
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body).toMatchObject({
          status: 401,
          code: 'INVALID_REFRESH_TOKEN',
          detail: 'Invalid refresh token.',
        });
        expect((response.body as { type: string }).type).toMatch(/invalid-refresh-token$/);
      }
      const bodies = responses.map(({ response }) => withoutCorrelationId(response.body));
      for (const body of bodies) {
        expect(body).toEqual(bodies[0]);
      }
      const challenges = responses.map(({ response }) => response.headers['www-authenticate']);
      for (const challenge of challenges) {
        expect(challenge).toEqual(challenges[0]);
      }
    });

    it('does not rotate the token of a disabled user', async () => {
      const { pair } = await loginNewUser('DISABLED');

      await refresh(pair.refreshToken);

      const row = await findRow(pair.refreshToken);
      expect(row.rotatedAt).toBeNull();
      expect(row.replacedById).toBeNull();
    });

    it('answers 401 and keeps the token usable when it loses a rotation race, leaving no orphan', async () => {
      const { pair } = await loginNewUser();
      const rowsBefore = testApp.refreshTokens.all().length;
      vi.spyOn(testApp.refreshTokens, 'markRotated').mockResolvedValueOnce(false);

      const response = await refresh(pair.refreshToken);

      expect(response.status).toBe(401);
      expect(testApp.refreshTokens.all()).toHaveLength(rowsBefore);
      vi.restoreAllMocks();
      expect((await refresh(pair.refreshToken)).status).toBe(200);
    });
  });

  describe('reuse detection', () => {
    it('revokes the whole family, including the newest token, when an old token is replayed after the grace window', async () => {
      const { pair } = await loginNewUser();
      const second = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const third = (await refresh(second.refreshToken)).body as TokenPairBody;
      const familyId = (await findRow(pair.refreshToken)).familyId;
      testApp.clock.advance(PAST_GRACE_MS);

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      const family = testApp.refreshTokens.all().filter((token) => token.familyId === familyId);
      expect(family).toHaveLength(3);
      for (const token of family) {
        expect(token.revokedAt).not.toBeNull();
      }
      expect((await refresh(third.refreshToken)).status).toBe(401);
    });

    it('logs a security event with user and family ids and no token values', async () => {
      const { userId, pair } = await loginNewUser();
      const next = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const row = await findRow(pair.refreshToken);
      testApp.lines.length = 0;
      testApp.clock.advance(PAST_GRACE_MS);

      await refresh(pair.refreshToken);

      const [event] = logLines(REUSE_LOG_MESSAGE);
      expect(event).toMatchObject({
        level: 'warn',
        event: 'refresh_token_reuse',
        userId,
        familyId: row.familyId,
        revokedCount: 2,
      });
      const logged = JSON.stringify(testApp.lines);
      expect(logged).not.toContain(pair.refreshToken);
      expect(logged).not.toContain(next.refreshToken);
    });

    it('does not touch another user or another family of the same user', async () => {
      const victim = await loginNewUser();
      const bystander = await loginNewUser();
      const secondLogin = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: victim.email, password: PASSWORD });
      await refresh(victim.pair.refreshToken);
      testApp.clock.advance(PAST_GRACE_MS);

      await refresh(victim.pair.refreshToken);

      expect((await refresh(bystander.pair.refreshToken)).status).toBe(200);
      expect((await refresh((secondLogin.body as TokenPairBody).refreshToken)).status).toBe(200);
    });
  });

  describe('the grace window', () => {
    it('answers a replay inside the window with 401 and leaves the family untouched', async () => {
      const { pair } = await loginNewUser();
      const next = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const family = (await findRow(pair.refreshToken)).familyId;
      testApp.lines.length = 0;
      testApp.clock.advance(DEFAULT_TEST_REUSE_GRACE_MS / 2);

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      expect(replay.body).not.toHaveProperty('refreshToken');
      expect(replay.body).not.toHaveProperty('accessToken');
      for (const token of testApp.refreshTokens.all().filter((row) => row.familyId === family)) {
        expect(token.revokedAt).toBeNull();
      }
      expect(logLines(REUSE_LOG_MESSAGE)).toHaveLength(0);
      expect(logLines(GRACE_LOG_MESSAGE)).toHaveLength(1);
      expect((await refresh(next.refreshToken)).status).toBe(200);
    });

    it('treats a replay at the end of the window as reuse', async () => {
      const { pair } = await loginNewUser();
      await refresh(pair.refreshToken);
      testApp.clock.advance(DEFAULT_TEST_REUSE_GRACE_MS);

      await refresh(pair.refreshToken);

      expect(logLines(REUSE_LOG_MESSAGE).length).toBeGreaterThan(0);
    });

    it('gives a replay inside the window on an already revoked family a plain 401', async () => {
      const { pair } = await loginNewUser();
      await refresh(pair.refreshToken);
      const family = (await findRow(pair.refreshToken)).familyId;
      await testApp.refreshTokens.revokeFamily(family, testApp.clock.now());
      testApp.lines.length = 0;

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      expect(logLines(REUSE_LOG_MESSAGE)).toHaveLength(0);
      expect(logLines(GRACE_LOG_MESSAGE)).toHaveLength(0);
    });

    it('gives a replay long after the window on an already revoked family a plain 401 too', async () => {
      const { pair } = await loginNewUser();
      await refresh(pair.refreshToken);
      const family = (await findRow(pair.refreshToken)).familyId;
      await testApp.refreshTokens.revokeFamily(family, testApp.clock.now());
      testApp.clock.advance(PAST_GRACE_MS);
      testApp.lines.length = 0;

      const replay = await refresh(pair.refreshToken);

      expect(replay.status).toBe(401);
      expect(logLines(REUSE_LOG_MESSAGE)).toHaveLength(0);
    });

    it('is switched off by a window of 0, so any replay is reuse', async () => {
      const strict = await createAuthTestApp({ reuseGraceMs: 0 });
      await strict.addUser({ email: 'strict@example.com', password: PASSWORD });
      const login = await request(strict.app)
        .post(LOGIN_PATH)
        .send({ email: 'strict@example.com', password: PASSWORD });
      const first = (login.body as TokenPairBody).refreshToken;
      const second = (await request(strict.app).post(REFRESH_PATH).send({ refreshToken: first }))
        .body as TokenPairBody;

      const replay = await request(strict.app).post(REFRESH_PATH).send({ refreshToken: first });

      expect(replay.status).toBe(401);
      const retry = await request(strict.app)
        .post(REFRESH_PATH)
        .send({ refreshToken: second.refreshToken });
      expect(retry.status).toBe(401);
    });
  });

  describe('input validation', () => {
    it.each([
      ['an empty body', {}],
      ['an empty token', { refreshToken: '' }],
      ['a numeric token', { refreshToken: 12345 }],
      ['an array token', { refreshToken: ['abc'] }],
      ['a 129-character token', { refreshToken: 'a'.repeat(129) }],
      ['an unknown field', { refreshToken: 'abc', userId: 'someone-else' }],
    ])('answers 422 for %s', async (_name, body) => {
      const response = await request(testApp.app).post(REFRESH_PATH).send(body);

      expect(response.status).toBe(422);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('answers 400 for malformed JSON', async () => {
      const response = await request(testApp.app)
        .post(REFRESH_PATH)
        .set('Content-Type', 'application/json')
        .send('{"refreshToken": ');

      expect(response.status).toBe(400);
    });
  });

  describe('secrets', () => {
    it('leaks no token or hash into any response body or log line', async () => {
      const { pair } = await loginNewUser();
      testApp.lines.length = 0;

      const success = await refresh(pair.refreshToken);
      const replay = await refresh(pair.refreshToken);
      testApp.clock.advance(PAST_GRACE_MS);
      const reuse = await refresh(pair.refreshToken);
      const unknown = await refresh(randomBytes(32).toString('base64url'));

      const next = success.body as TokenPairBody;
      const hashes = testApp.refreshTokens.all().map((token) => token.tokenHash);
      const logged = JSON.stringify(testApp.lines);
      const forbidden = [pair.refreshToken, next.refreshToken, next.accessToken, ...hashes];
      for (const secret of forbidden) {
        expect(secret).not.toBe('');
        expect(logged).not.toContain(secret);
        for (const response of [replay, reuse, unknown]) {
          expect(JSON.stringify(response.body)).not.toContain(secret);
        }
      }
      expect(JSON.stringify(success.body)).not.toContain('passwordHash');
      for (const hash of hashes) {
        expect(JSON.stringify(success.body)).not.toContain(hash);
      }
    });
  });
});
