import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAuthTestApp, type AuthTestApp } from '../../support/create-auth-test-app';
import {
  forgeUnsignedToken,
  mintAccessToken,
  tamperWithPayload,
} from '../../support/mint-access-token';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from '../../support/test-signing-keys';

const ME_PATH = '/v1/users/me';
const LOGIN_PATH = '/v1/auth/login';
const PASSWORD = 'correct-horse-battery';
const MINUTE_MS = 60 * 1000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EXPECTED_FIELDS = [
  'createdAt',
  'email',
  'emailVerified',
  'id',
  'name',
  'phone',
  'role',
  'status',
  'tenantId',
  'updatedAt',
];

/**
 * @param body - A problem body.
 * @returns The body without the fields that differ per request.
 */
function withoutPerRequestFields(body: unknown): unknown {
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      ([key]) => key !== 'correlationId' && key !== 'instance',
    ),
  );
}

describe('GET /v1/users/me', () => {
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
    return `me-${String(emailCounter)}@example.com`;
  }

  /**
   * Creates a user and logs them in.
   *
   * @returns The user id and a real access token from login.
   */
  async function loginNewUser(): Promise<{ userId: string; accessToken: string }> {
    const email = nextEmail();
    const user = await testApp.addUser({ email, password: PASSWORD });
    const response = await request(testApp.app)
      .post(LOGIN_PATH)
      .send({ email, password: PASSWORD });
    return { userId: user.id, accessToken: (response.body as { accessToken: string }).accessToken };
  }

  /**
   * @param authorization - The Authorization header value, or undefined to send none.
   * @returns The response.
   */
  function getMe(authorization?: string): request.Test {
    const call = request(testApp.app).get(ME_PATH);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  }

  describe('success', () => {
    it('returns exactly the spec User fields, nothing else, and no-store', async () => {
      const { userId, accessToken } = await loginNewUser();

      const response = await getMe(`Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(EXPECTED_FIELDS);
      expect(body).toMatchObject({
        id: userId,
        emailVerified: false,
        name: 'Test User',
        phone: null,
        role: { key: 'CUSTOMER', name: 'Customer' },
        tenantId: null,
        status: 'ACTIVE',
      });
      expect(body.createdAt).toMatch(ISO_TIMESTAMP);
      expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2|tokenHash/i);
    });

    it('takes the data from the database, not from the token claims', async () => {
      const { userId } = await loginNewUser();
      const token = await mintAccessToken({
        privateKey: testApp.keys.privateKey,
        keyId: testApp.keyId,
        subject: userId,
        issuedAt: testApp.clock.now(),
        claims: { role: 'ADMIN', permissions: ['user:manage'], tenantId: randomUUID() },
      });

      const response = await getMe(`Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ role: { key: 'CUSTOMER' }, tenantId: null });
      expect(JSON.stringify(response.body)).not.toContain('user:manage');
    });
  });

  describe('every kind of invalid access token gets the same 401', () => {
    /**
     * @returns Labelled bad Authorization header values.
     */
    async function buildBadCredentials(): Promise<[string, string | undefined][]> {
      const { userId, accessToken } = await loginNewUser();
      const issuedAt = testApp.clock.now();
      const valid = (overrides: Parameters<typeof mintAccessToken>[0]) =>
        mintAccessToken({ issuedAt, subject: userId, keyId: testApp.keyId, ...overrides });
      const expired = await valid({
        privateKey: testApp.keys.privateKey,
        issuedAt: new Date(issuedAt.getTime() - 20 * MINUTE_MS),
      });
      return [
        ['missing header', undefined],
        ['empty header', ''],
        ['wrong scheme', `Basic ${accessToken}`],
        ['no token', 'Bearer'],
        ['empty token', 'Bearer '],
        ['two tokens', `Bearer ${accessToken} ${accessToken}`],
        ['garbage', 'Bearer not.a.jwt'],
        ['expired', `Bearer ${expired}`],
        ['tampered', `Bearer ${tamperWithPayload(accessToken, { role: 'ADMIN' })}`],
        [
          'wrong audience',
          `Bearer ${await valid({ privateKey: testApp.keys.privateKey, audience: 'other' })}`,
        ],
        [
          'wrong issuer',
          `Bearer ${await valid({ privateKey: testApp.keys.privateKey, issuer: 'https://evil' })}`,
        ],
        [
          'alg none',
          `Bearer ${forgeUnsignedToken({
            sub: userId,
            role: 'ADMIN',
            permissions: [],
            auth_time: 1,
            iss: TEST_ISSUER,
            aud: TEST_AUDIENCE,
            jti: randomUUID(),
            iat: Math.floor(issuedAt.getTime() / 1000),
            exp: Math.floor(issuedAt.getTime() / 1000) + 600,
          })}`,
        ],
        [
          'unknown kid',
          `Bearer ${await valid({ privateKey: testApp.keys.privateKey, keyId: 'unknown-kid' })}`,
        ],
        [
          'signed by another key',
          `Bearer ${await valid({ privateKey: generateTestSigningKeys().privateKey })}`,
        ],
        ['very long header', `Bearer ${'a'.repeat(8_500)}`],
      ];
    }

    it('answers 401 with an identical problem body, challenge and no user data', async () => {
      const cases = await buildBadCredentials();

      const responses = await Promise.all(cases.map(([, header]) => getMe(header)));

      const bodies = responses.map((response) => withoutPerRequestFields(response.body));
      for (const [index, response] of responses.entries()) {
        expect(response.status, cases[index]?.[0]).toBe(401);
        expect(response.type).toBe('application/problem+json');
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(bodies[index]).toEqual(bodies[0]);
      }
      expect(bodies[0]).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    });
  });

  describe('the user is looked up on every request', () => {
    it('gives the same 401 when the user no longer exists', async () => {
      const token = await mintAccessToken({
        privateKey: testApp.keys.privateKey,
        keyId: testApp.keyId,
        issuedAt: testApp.clock.now(),
        subject: randomUUID(),
      });
      const { accessToken } = await loginNewUser();

      const gone = await getMe(`Bearer ${token}`);
      const bad = await getMe(`Bearer ${accessToken}x`);

      expect(gone.status).toBe(401);
      expect(withoutPerRequestFields(gone.body)).toEqual(withoutPerRequestFields(bad.body));
    });

    it('gives the same 401 once the user is DISABLED, though the token is still valid', async () => {
      const { userId, accessToken } = await loginNewUser();
      expect((await getMe(`Bearer ${accessToken}`)).status).toBe(200);
      await testApp.users.updateStatus(userId, 'DISABLED');

      const response = await getMe(`Bearer ${accessToken}`);
      const reference = await getMe(undefined);

      expect(response.status).toBe(401);
      expect(withoutPerRequestFields(response.body)).toEqual(
        withoutPerRequestFields(reference.body),
      );
    });
  });

  describe('logging', () => {
    it('logs the internal reason without the token', async () => {
      const { accessToken } = await loginNewUser();
      testApp.lines.length = 0;

      await getMe(`Bearer ${tamperWithPayload(accessToken, { role: 'ADMIN' })}`);
      await getMe(undefined);

      const failures = testApp.lines.filter((line) => line.msg === 'access token rejected');
      expect(failures.map((line) => line.reason)).toEqual(['bad_signature', 'missing_header']);
      const everything = JSON.stringify(testApp.lines);
      expect(everything).not.toContain(accessToken);
      expect(everything).not.toContain(accessToken.split('.')[2] ?? 'unreachable');
    });
  });

  describe('limitation: access tokens outlive logout', () => {
    it('still answers 200 after the session is logged out, until the token expires', async () => {
      const email = nextEmail();
      await testApp.addUser({ email, password: PASSWORD });
      const login = await request(testApp.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
      const pair = login.body as { accessToken: string; refreshToken: string };

      await request(testApp.app).post('/v1/auth/logout').send({ refreshToken: pair.refreshToken });

      // ADR-0013 weak point 1: revocation lags by up to the access-token lifetime (10 minutes).
      expect((await getMe(`Bearer ${pair.accessToken}`)).status).toBe(200);
      testApp.clock.advance(11 * MINUTE_MS);
      expect((await getMe(`Bearer ${pair.accessToken}`)).status).toBe(401);
    });
  });
});
