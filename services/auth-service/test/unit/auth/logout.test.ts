import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { hashRefreshToken } from '@/auth/refresh-token-hash';
import { REFRESH_IDLE_TTL_MS } from '@/auth/token-constants';

import { createAuthTestApp, type AuthTestApp } from '../../support/create-auth-test-app';

const LOGIN_PATH = '/v1/auth/login';
const REFRESH_PATH = '/v1/auth/refresh';
const LOGOUT_PATH = '/v1/auth/logout';
const PASSWORD = 'correct-horse-battery';
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 11_000;
const LOGOUT_LOG_MESSAGE = 'logout';

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
}

describe('POST /v1/auth/logout', () => {
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
    return `logout-${String(emailCounter)}@example.com`;
  }

  /**
   * Creates a user and logs them in.
   *
   * @returns The user id, email and the login's token pair.
   */
  async function loginNewUser(): Promise<{ userId: string; email: string; pair: TokenPairBody }> {
    const email = nextEmail();
    const user = await testApp.addUser({ email, password: PASSWORD });
    const pair = await loginAs(email);
    return { userId: user.id, email, pair };
  }

  /**
   * @param email - The user's email.
   * @returns The token pair of a new login (a new family).
   */
  async function loginAs(email: string): Promise<TokenPairBody> {
    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email, password: PASSWORD });
    return response.body as TokenPairBody;
  }

  /**
   * @param refreshToken - The raw token to present.
   * @returns The response.
   */
  function logout(refreshToken: string): request.Test {
    return request(testApp.app).post(LOGOUT_PATH).send({ refreshToken });
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
   * @returns The family id of its stored row.
   */
  async function familyOf(refreshToken: string): Promise<string> {
    const row = await testApp.refreshTokens.findByTokenHash(hashRefreshToken(refreshToken));
    if (row === null) {
      throw new Error('test setup: the token is not stored');
    }
    return row.familyId;
  }

  /**
   * @param familyId - A family id.
   * @returns Every stored token of that family.
   */
  function rowsOfFamily(familyId: string) {
    return testApp.refreshTokens.all().filter((row) => row.familyId === familyId);
  }

  describe('revoking the session', () => {
    it('answers 204 with an empty body and revokes the token, so refresh no longer works', async () => {
      const { pair } = await loginNewUser();

      const response = await logout(pair.refreshToken);

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect((await refresh(pair.refreshToken)).status).toBe(401);
    });

    it('sets revokedAt on every token of the family, rotated ones included', async () => {
      const { pair } = await loginNewUser();
      const second = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const third = (await refresh(second.refreshToken)).body as TokenPairBody;
      const familyId = await familyOf(pair.refreshToken);
      expect(rowsOfFamily(familyId)).toHaveLength(3);

      const response = await logout(third.refreshToken);

      expect(response.status).toBe(204);
      for (const row of rowsOfFamily(familyId)) {
        expect(row.revokedAt).not.toBeNull();
      }
      expect((await refresh(third.refreshToken)).status).toBe(401);
    });

    it('still revokes the whole family when an old, already rotated token is presented', async () => {
      const { pair } = await loginNewUser();
      const second = (await refresh(pair.refreshToken)).body as TokenPairBody;
      const third = (await refresh(second.refreshToken)).body as TokenPairBody;
      const familyId = await familyOf(pair.refreshToken);

      const response = await logout(pair.refreshToken);

      expect(response.status).toBe(204);
      expect(rowsOfFamily(familyId).every((row) => row.revokedAt !== null)).toBe(true);
      // The live head of the session no longer works either.
      expect((await refresh(third.refreshToken)).status).toBe(401);
    });

    it('leaves other families of the same user and other users alone', async () => {
      const first = await loginNewUser();
      const otherDevice = await loginAs(first.email);
      const stranger = await loginNewUser();
      const untouchedFamilies = [
        await familyOf(otherDevice.refreshToken),
        await familyOf(stranger.pair.refreshToken),
      ];

      await logout(first.pair.refreshToken);

      for (const familyId of untouchedFamilies) {
        expect(rowsOfFamily(familyId).every((row) => row.revokedAt === null)).toBe(true);
      }
      expect((await refresh(otherDevice.refreshToken)).status).toBe(200);
      expect((await refresh(stranger.pair.refreshToken)).status).toBe(200);
    });

    it('is safe to call twice: both answer 204 and the first revokedAt is kept', async () => {
      const { pair } = await loginNewUser();
      const familyId = await familyOf(pair.refreshToken);

      const first = await logout(pair.refreshToken);
      const revokedAtAfterFirst = rowsOfFamily(familyId).map((row) => row.revokedAt);
      testApp.clock.advance(PAST_GRACE_MS);
      const second = await logout(pair.refreshToken);

      expect(first.status).toBe(204);
      expect(second.status).toBe(204);
      expect(rowsOfFamily(familyId).map((row) => row.revokedAt)).toEqual(revokedAtAfterFirst);
    });
  });

  describe('non-revealing success', () => {
    it('answers the same 204 for an unknown token and changes nothing', async () => {
      await loginNewUser();
      const before = testApp.refreshTokens.all();

      const response = await logout('this-token-was-never-issued');

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(testApp.refreshTokens.all()).toEqual(before);
    });

    it('answers the same 204 for a malformed token (wrong shape, but 1 to 128 characters)', async () => {
      const before = testApp.refreshTokens.all();

      for (const refreshToken of ['x', '   ', 'not base64url !!!', 'a'.repeat(128)]) {
        const response = await logout(refreshToken);
        expect(response.status).toBe(204);
        expect(response.text).toBe('');
      }
      expect(testApp.refreshTokens.all()).toEqual(before);
    });

    it('answers the same 204 for a token that was already revoked and keeps its revokedAt', async () => {
      const { pair } = await loginNewUser();
      const familyId = await familyOf(pair.refreshToken);
      await logout(pair.refreshToken);
      const before = rowsOfFamily(familyId);
      testApp.clock.advance(DAY_MS);

      const response = await logout(pair.refreshToken);

      expect(response.status).toBe(204);
      expect(rowsOfFamily(familyId)).toEqual(before);
    });

    it('answers the same 204 for an expired token whose family has a live head, and ends that session', async () => {
      const { pair } = await loginNewUser();
      const familyId = await familyOf(pair.refreshToken);
      // Refresh late in the token's life: the successor then outlives the first token.
      testApp.clock.advance(REFRESH_IDLE_TTL_MS - DAY_MS);
      const head = (await refresh(pair.refreshToken)).body as TokenPairBody;
      testApp.clock.advance(2 * DAY_MS);
      const [first] = rowsOfFamily(familyId);
      expect(first?.expiresAt.getTime()).toBeLessThan(testApp.clock.now().getTime());

      const response = await logout(pair.refreshToken);

      expect(response.status).toBe(204);
      expect((await refresh(head.refreshToken)).status).toBe(401);
      expect(rowsOfFamily(familyId).every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('gives a body that fails validation a 422, with the same shape as refresh', async () => {
      for (const body of [{}, { refreshToken: '' }, { refreshToken: 'a'.repeat(129) }]) {
        const response = await request(testApp.app).post(LOGOUT_PATH).send(body);
        expect(response.status).toBe(422);
        expect(response.type).toBe('application/problem+json');
      }
      const extra = await request(testApp.app)
        .post(LOGOUT_PATH)
        .send({ refreshToken: 'abc', allDevices: true });
      expect(extra.status).toBe(422);
    });
  });

  describe('logging', () => {
    it('logs the outcome with ids only, never the token or its hash', async () => {
      const { pair, userId } = await loginNewUser();
      const familyId = await familyOf(pair.refreshToken);
      testApp.lines.length = 0;

      await logout(pair.refreshToken);
      await logout(pair.refreshToken);
      await logout('this-token-was-never-issued');

      const logLines = testApp.lines.filter((line) => line.msg === LOGOUT_LOG_MESSAGE);
      expect(logLines.map((line) => line.outcome)).toEqual([
        'revoked',
        'already_revoked',
        'unknown_token',
      ]);
      expect(logLines[0]).toMatchObject({ userId, familyId, revokedCount: 1 });
      const everything = JSON.stringify(testApp.lines);
      expect(everything).not.toContain(pair.refreshToken);
      expect(everything).not.toContain(hashRefreshToken(pair.refreshToken));
      expect(everything).not.toContain('this-token-was-never-issued');
    });

    it('never puts a token or hash in any response body', async () => {
      const { pair } = await loginNewUser();

      const responses = [
        await logout(pair.refreshToken),
        await logout(randomUUID()),
        await request(testApp.app).post(LOGOUT_PATH).send({}),
      ];

      for (const response of responses) {
        const text = JSON.stringify(response.body) + response.text;
        expect(text).not.toContain(pair.refreshToken);
        expect(text).not.toContain(hashRefreshToken(pair.refreshToken));
      }
    });
  });
});
