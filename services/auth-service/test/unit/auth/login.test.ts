import { createHash } from 'node:crypto';

import { jwtVerify } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { parseArgon2idPhc } from '@/auth/phc-string';

import { createAuthTestApp, type AuthTestApp } from '../../support/create-auth-test-app';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_KEY_ID } from '../../support/test-signing-keys';

const LOGIN_PATH = '/v1/auth/login';
const EMAIL = 'asha@example.com';
const PASSWORD = 'correct-horse-battery';
const ACCESS_TOKEN_LIFETIME_SECONDS = 600;
const REFRESH_IDLE_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_TOLERANCE_MS = 5_000;
const RAISED_MEMORY_KIB = 32 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

/**
 * @param value - Any value.
 * @returns The value with `correlationId` removed, so two problem bodies can be compared.
 */
function withoutCorrelationId(value: unknown): unknown {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'correlationId'),
  );
}

describe('POST /v1/auth/login', () => {
  let testApp: AuthTestApp;

  beforeAll(async () => {
    testApp = await createAuthTestApp();
  });

  describe('on success', () => {
    it('answers 200 with the token pair the OpenAPI spec defines', async () => {
      const user = await testApp.addUser({ email: 'success@example.com', password: PASSWORD });

      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .set('User-Agent', 'vitest-agent')
        .send({ email: 'success@example.com', password: PASSWORD });

      const body = response.body as TokenPairBody;
      expect(response.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(
        ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType'].sort(),
      );
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(ACCESS_TOKEN_LIFETIME_SECONDS);
      expect(body.refreshExpiresIn).toBe(REFRESH_IDLE_LIFETIME_SECONDS);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(user.id).toMatch(UUID_PATTERN);
    });

    it('issues an EdDSA access token with the documented claims', async () => {
      const user = await testApp.addUser({ email: 'claims@example.com', password: PASSWORD });

      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'claims@example.com', password: PASSWORD });

      const { accessToken } = response.body as TokenPairBody;
      const { payload, protectedHeader } = await jwtVerify(accessToken, testApp.keys.publicKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        algorithms: ['EdDSA'],
      });
      expect(protectedHeader).toMatchObject({ alg: 'EdDSA', kid: TEST_KEY_ID });
      expect(payload.sub).toBe(user.id);
      expect(payload).toMatchObject({ role: 'CUSTOMER', permissions: [], auth_time: payload.iat });
      expect(payload).not.toHaveProperty('tenantId');
      expect(payload.jti).toMatch(UUID_PATTERN);
      expect(payload.exp).toBe((payload.iat ?? 0) + ACCESS_TOKEN_LIFETIME_SECONDS);
      expect(Math.abs((payload.iat ?? 0) * 1000 - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
    });

    it('rejects the access token once it has expired', async () => {
      await testApp.addUser({ email: 'expiry@example.com', password: PASSWORD });
      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'expiry@example.com', password: PASSWORD });

      const { accessToken } = response.body as TokenPairBody;
      const afterExpiry = new Date(Date.now() + (ACCESS_TOKEN_LIFETIME_SECONDS + 1) * 1000);
      await expect(
        jwtVerify(accessToken, testApp.keys.publicKey, {
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
          currentDate: afterExpiry,
        }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    });

    it('stores only the SHA-256 hash of the refresh token, with its session details', async () => {
      const user = await testApp.addUser({ email: 'stored@example.com', password: PASSWORD });

      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .set('User-Agent', 'vitest-agent')
        .send({ email: 'stored@example.com', password: PASSWORD });

      const { refreshToken } = response.body as TokenPairBody;
      const stored = testApp.refreshTokens.all().filter((token) => token.userId === user.id);
      expect(stored).toHaveLength(1);
      const [token] = stored;
      expect(token?.tokenHash).toBe(createHash('sha256').update(refreshToken).digest('hex'));
      expect(JSON.stringify(token)).not.toContain(refreshToken);
      expect(token?.familyId).toMatch(UUID_PATTERN);
      expect(token?.userAgent).toBe('vitest-agent');
      expect(token?.ip).not.toBeNull();
      const lifetimeMs = (token?.expiresAt.getTime() ?? 0) - (token?.authTime.getTime() ?? 0);
      expect(lifetimeMs).toBe(REFRESH_IDLE_LIFETIME_SECONDS * 1000);
    });

    it('creates a separate token family for every login of the same user', async () => {
      const user = await testApp.addUser({ email: 'twice@example.com', password: PASSWORD });

      const first = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'twice@example.com', password: PASSWORD });
      const second = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'twice@example.com', password: PASSWORD });

      const stored = testApp.refreshTokens.all().filter((token) => token.userId === user.id);
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((token) => token.familyId)).size).toBe(2);
      expect(new Set(stored.map((token) => token.tokenHash)).size).toBe(2);
      expect((first.body as TokenPairBody).refreshToken).not.toBe(
        (second.body as TokenPairBody).refreshToken,
      );
    });

    it('treats the email case-insensitively and ignores surrounding whitespace', async () => {
      await testApp.addUser({ email: 'mixed@example.com', password: PASSWORD });

      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: '  Mixed@Example.COM \t', password: PASSWORD });

      expect(response.status).toBe(200);
    });
  });

  describe('on failure', () => {
    const FAILURE_EMAIL = 'failure@example.com';

    beforeAll(async () => {
      await testApp.addUser({ email: FAILURE_EMAIL, password: PASSWORD });
      await testApp.addUser({
        email: 'disabled@example.com',
        password: PASSWORD,
        status: 'DISABLED',
      });
      await testApp.addUser({
        email: 'nohash@example.com',
        password: PASSWORD,
        passwordHash: null,
      });
    });

    /**
     * @returns The kinds of failed login, which must be indistinguishable to the caller.
     */
    async function collectFailures(): Promise<
      { readonly name: string; readonly response: request.Response }[]
    > {
      const attempts = [
        ['wrong password', { email: FAILURE_EMAIL, password: 'not-the-password' }],
        ['unknown email', { email: 'nobody@example.com', password: PASSWORD }],
        [
          'disabled user with the right password',
          { email: 'disabled@example.com', password: PASSWORD },
        ],
        ['user without a password', { email: 'nohash@example.com', password: PASSWORD }],
      ] as const;
      return Promise.all(
        attempts.map(async ([name, body]) => ({
          name,
          response: await request(testApp.app).post(LOGIN_PATH).send(body),
        })),
      );
    }

    it('answers every failure with the same 401 problem', async () => {
      const failures = await collectFailures();

      for (const { response } of failures) {
        expect(response.status).toBe(401);
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body).toMatchObject({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          detail: 'Invalid email or password.',
        });
        expect((response.body as { type: string }).type).toMatch(/invalid-credentials$/);
      }
      const bodies = failures.map(({ response }) => withoutCorrelationId(response.body));
      for (const body of bodies) {
        expect(body).toEqual(bodies[0]);
      }
      const headers = failures.map(({ response }) => response.headers['www-authenticate']);
      for (const header of headers) {
        expect(header).toEqual(headers[0]);
      }
    });

    it('creates no refresh token for a failed login', async () => {
      const before = testApp.refreshTokens.all().length;

      await collectFailures();

      expect(testApp.refreshTokens.all()).toHaveLength(before);
    });

    it('verifies exactly one hash per attempt, against a dummy hash when the user is unknown', async () => {
      testApp.verifySpy.mockClear();

      await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'ghost@example.com', password: PASSWORD });

      expect(testApp.verifySpy).toHaveBeenCalledTimes(1);
      expect(testApp.verifySpy).toHaveBeenCalledWith(PASSWORD, testApp.dummyPasswordHash);
    });

    it('still verifies the real hash for a disabled user, so the timing matches', async () => {
      const user = await testApp.addUser({
        email: 'disabled-timing@example.com',
        password: PASSWORD,
        status: 'DISABLED',
      });
      testApp.verifySpy.mockClear();

      await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'disabled-timing@example.com', password: PASSWORD });

      expect(testApp.verifySpy).toHaveBeenCalledTimes(1);
      expect(testApp.verifySpy).toHaveBeenCalledWith(PASSWORD, user.passwordHash);
    });
  });

  describe('input validation', () => {
    it.each([
      ['an empty body', {}],
      ['a missing password', { email: EMAIL }],
      ['a missing email', { password: PASSWORD }],
      ['a numeric password', { email: EMAIL, password: 12345 }],
      ['an array email', { email: [EMAIL], password: PASSWORD }],
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
      ['an unknown field', { email: EMAIL, password: PASSWORD, role: 'ADMIN' }],
      ['a 129-character password', { email: EMAIL, password: 'x'.repeat(129) }],
      ['a 400-character email', { email: `${'a'.repeat(400)}@example.com`, password: PASSWORD }],
    ])('answers 422 for %s and never reaches the hasher', async (_name, body) => {
      testApp.verifySpy.mockClear();

      const response = await request(testApp.app).post(LOGIN_PATH).send(body);

      expect(response.status).toBe(422);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(testApp.verifySpy).not.toHaveBeenCalled();
    });

    it('answers 400 for malformed JSON', async () => {
      const response = await request(testApp.app)
        .post(LOGIN_PATH)
        .set('Content-Type', 'application/json')
        .send('{"email": ');

      expect(response.status).toBe(400);
    });
  });

  describe('rehash on login', () => {
    it('upgrades a hash made with weaker parameters than the current ones', async () => {
      const stronger = await createAuthTestApp({
        hasher: new Argon2idPasswordHasher({ memoryKib: RAISED_MEMORY_KIB }),
      });
      const user = await stronger.addUser({ email: 'old@example.com', password: PASSWORD });
      const oldHash = user.passwordHash ?? '';
      expect(parseArgon2idPhc(oldHash)?.memoryKib).toBeLessThan(RAISED_MEMORY_KIB);

      const response = await request(stronger.app)
        .post(LOGIN_PATH)
        .send({ email: 'old@example.com', password: PASSWORD });

      expect(response.status).toBe(200);
      const upgraded = (await stronger.users.findById(user.id))?.passwordHash ?? '';
      expect(upgraded).not.toBe(oldHash);
      expect(parseArgon2idPhc(upgraded)?.memoryKib).toBe(RAISED_MEMORY_KIB);
      expect(await stronger.hasher.verify(PASSWORD, upgraded)).toBe(true);
      const again = await request(stronger.app)
        .post(LOGIN_PATH)
        .send({ email: 'old@example.com', password: PASSWORD });
      expect(again.status).toBe(200);
    });

    it('leaves a hash that already uses the current parameters alone', async () => {
      const user = await testApp.addUser({ email: 'current@example.com', password: PASSWORD });

      await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'current@example.com', password: PASSWORD });

      expect((await testApp.users.findById(user.id))?.passwordHash).toBe(user.passwordHash);
    });

    it('does not rehash after a failed login', async () => {
      const stronger = await createAuthTestApp({
        hasher: new Argon2idPasswordHasher({ memoryKib: RAISED_MEMORY_KIB }),
      });
      const user = await stronger.addUser({ email: 'wrong@example.com', password: PASSWORD });

      await request(stronger.app)
        .post(LOGIN_PATH)
        .send({ email: 'wrong@example.com', password: 'not-the-password' });

      expect((await stronger.users.findById(user.id))?.passwordHash).toBe(user.passwordHash);
    });
  });

  describe('secrets', () => {
    it('leaks no password, hash or token into the response body or the logs', async () => {
      const user = await testApp.addUser({ email: 'secrets@example.com', password: PASSWORD });
      testApp.lines.length = 0;

      const success = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'secrets@example.com', password: PASSWORD });
      const failure = await request(testApp.app)
        .post(LOGIN_PATH)
        .send({ email: 'secrets@example.com', password: 'not-the-password' });

      const { accessToken, refreshToken } = success.body as TokenPairBody;
      const stored = testApp.refreshTokens.all().find((token) => token.userId === user.id);
      const logged = JSON.stringify(testApp.lines);
      const forbidden = [
        PASSWORD,
        'not-the-password',
        user.passwordHash ?? '',
        accessToken,
        refreshToken,
        stored?.tokenHash ?? '',
      ];
      for (const secret of forbidden) {
        expect(secret).not.toBe('');
        expect(logged).not.toContain(secret);
        expect(JSON.stringify(failure.body)).not.toContain(secret);
      }
      expect(JSON.stringify(success.body)).not.toContain(user.passwordHash ?? '');
      expect(logged).not.toContain('secrets@example.com');
    });
  });
});
