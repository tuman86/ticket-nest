import { createHash, type KeyObject } from 'node:crypto';

import { Jwks } from '@ticketnest/contracts';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  importJWK,
  jwtVerify,
} from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAuthTestApp, type AuthTestApp } from '../../support/create-auth-test-app';
import { mintAccessToken } from '../../support/mint-access-token';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from '../../support/test-signing-keys';

const JWKS_PATH = '/.well-known/jwks.json';
const LOGIN_PATH = '/v1/auth/login';
const ME_PATH = '/v1/users/me';
const PASSWORD = 'correct-horse-battery';
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];
const EXPECTED_CONTENT_TYPE = 'application/jwk-set+json';
const EXPECTED_CACHE_CONTROL = 'public, max-age=300';

interface PublishedJwk {
  kty: string;
  crv: string;
  x: string;
  use: string;
  alg: string;
  kid: string;
}

interface JwkBody {
  keys: PublishedJwk[];
}

/**
 * @param value - Parsed JSON.
 * @returns Every object member name found anywhere in it, at any depth.
 */
function collectMemberNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectMemberNames);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([name, child]) => [name, ...collectMemberNames(child)]);
  }
  return [];
}

/**
 * @param testApp - The app to sign in against.
 * @param email - An unused email.
 * @returns The access token a fresh login issued.
 */
async function loginNewUser(testApp: AuthTestApp, email: string): Promise<string> {
  await testApp.addUser({ email, password: PASSWORD });
  const response = await request(testApp.app).post(LOGIN_PATH).send({ email, password: PASSWORD });
  return (response.body as { accessToken: string }).accessToken;
}

/**
 * @param publicKey - An Ed25519 public key.
 * @returns Its RFC 7638 thumbprint, the kid the service gives it.
 */
async function kidOf(publicKey: KeyObject): Promise<string> {
  return calculateJwkThumbprint(await exportJWK(publicKey));
}

describe('GET /.well-known/jwks.json', () => {
  let testApp: AuthTestApp;

  beforeAll(async () => {
    testApp = await createAuthTestApp();
  });

  describe('the response', () => {
    it('answers 200 with a key set whose every key has kty, use, alg and kid', async () => {
      const response = await request(testApp.app).get(JWKS_PATH);

      expect(response.status).toBe(200);
      const body = Jwks.parse(response.body);
      expect(body.keys).toHaveLength(1);
      for (const key of (response.body as JwkBody).keys) {
        expect(key).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
        expect(typeof key.kid).toBe('string');
        expect(typeof key.x).toBe('string');
      }
    });

    it('needs no credentials', async () => {
      const response = await request(testApp.app).get(JWKS_PATH);

      expect(response.status).toBe(200);
      expect(response.headers['www-authenticate']).toBeUndefined();
    });

    it('carries exactly the chosen Content-Type and Cache-Control', async () => {
      const response = await request(testApp.app).get(JWKS_PATH);

      expect(response.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
      expect(response.headers['cache-control']).toBe(EXPECTED_CACHE_CONTROL);
    });

    it('never contains a private member, at any depth, nor any private key material', async () => {
      const response = await request(testApp.app).get(JWKS_PATH);

      const names = collectMemberNames(JSON.parse(response.text));
      for (const member of PRIVATE_MEMBERS) {
        expect(names).not.toContain(member);
      }
      const privateJwk = testApp.keys.privateKey.export({ format: 'jwk' });
      const pkcs8 = testApp.keys.privateKey.export({ type: 'pkcs8', format: 'der' });
      expect(response.text.length).toBeGreaterThan(0);
      expect(privateJwk.d).toBeTruthy();
      expect(response.text).not.toContain(privateJwk.d ?? 'unreachable');
      expect(response.text).not.toContain(pkcs8.toString('base64'));
      expect(response.text).not.toContain(pkcs8.toString('base64url'));
      expect(response.text).not.toContain(pkcs8.toString('hex'));
    });

    it('is identical on repeated calls, including its ETag', async () => {
      const first = await request(testApp.app).get(JWKS_PATH);
      const second = await request(testApp.app).get(JWKS_PATH);
      const third = await request(testApp.app).get(JWKS_PATH);

      expect(second.text).toBe(first.text);
      expect(third.text).toBe(first.text);
      expect(second.get('ETag')).toBe(first.get('ETag'));
      expect(third.get('ETag')).toBe(first.get('ETag'));
    });
  });

  describe('ETag revalidation', () => {
    it('sends a strong ETag that is a hash of the body', async () => {
      const response = await request(testApp.app).get(JWKS_PATH);

      const etag = response.get('ETag');
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
      const expected = createHash('sha256').update(response.text).digest('base64url');
      expect(etag).toBe(`"${expected}"`);
    });

    it('answers 304 with no body to a matching If-None-Match, keeping the cache headers', async () => {
      const first = await request(testApp.app).get(JWKS_PATH);
      const etag = first.get('ETag');
      expect(etag).toBeTruthy();

      const second = await request(testApp.app)
        .get(JWKS_PATH)
        .set('If-None-Match', etag ?? '');

      expect(second.status).toBe(304);
      expect(second.text).toBe('');
      expect(second.get('ETag')).toBe(first.get('ETag'));
      expect(second.headers['cache-control']).toBe(EXPECTED_CACHE_CONTROL);
    });

    it('answers 200 with the full set to a different If-None-Match', async () => {
      const response = await request(testApp.app).get(JWKS_PATH).set('If-None-Match', '"stale"');

      expect(response.status).toBe(200);
      expect(Jwks.safeParse(response.body).success).toBe(true);
    });

    it('answers HEAD like GET, without a body', async () => {
      const get = await request(testApp.app).get(JWKS_PATH);

      const head = await request(testApp.app).head(JWKS_PATH);

      expect(head.status).toBe(200);
      expect(head.text).toBeUndefined();
      expect(head.get('ETag')).toBe(get.get('ETag'));
      expect(head.headers['content-type']).toBe(EXPECTED_CONTENT_TYPE);
    });
  });

  describe.each(['post', 'put', 'patch', 'delete'] as const)('%s', (method) => {
    it('answers 405 problem+json with an Allow header', async () => {
      const response = await request(testApp.app)[method](JWKS_PATH).send({});

      expect(response.status).toBe(405);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.get('Allow')).toBe('GET, HEAD');
      expect(response.body).toMatchObject({
        type: 'https://api.ticketnest.example/problems/method-not-allowed',
        status: 405,
        code: 'METHOD_NOT_ALLOWED',
        instance: JWKS_PATH,
      });
    });
  });

  describe('against the tokens the service issues', () => {
    it('lists the kid of a freshly issued login access token', async () => {
      const accessToken = await loginNewUser(testApp, 'kid@example.com');

      const { kid } = decodeProtectedHeader(accessToken);
      const response = await request(testApp.app).get(JWKS_PATH);

      const kids = (response.body as JwkBody).keys.map((key) => key.kid);
      expect(kid).toBe(testApp.keyId);
      expect(kids).toContain(kid);
    });

    it('verifies a login access token using only the published key set', async () => {
      const accessToken = await loginNewUser(testApp, 'only-jwks@example.com');
      const response = await request(testApp.app).get(JWKS_PATH);

      const header = decodeProtectedHeader(accessToken);
      const published = (response.body as JwkBody).keys.find((key) => key.kid === header.kid);
      expect(published).toBeDefined();
      expect(published?.alg).toBe(header.alg);
      const verificationKey = await importJWK(published ?? {}, 'EdDSA');
      const { payload } = await jwtVerify(accessToken, verificationKey, {
        algorithms: ['EdDSA'],
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
      });

      expect(payload.sub).toBeTruthy();
    });
  });

  describe('during a key rotation', () => {
    let rotatingApp: AuthTestApp;
    const previous = generateTestSigningKeys();

    beforeAll(async () => {
      rotatingApp = await createAuthTestApp({ additionalPublicKeys: [previous.publicKey] });
    });

    it('publishes the signing key first and the previous key after it', async () => {
      const response = await request(rotatingApp.app).get(JWKS_PATH);

      const kids = (response.body as JwkBody).keys.map((key) => key.kid);
      expect(kids).toEqual([rotatingApp.keyId, await kidOf(previous.publicKey)]);
    });

    it('verifies a token signed by the previous key against the published set', async () => {
      const previousKid = await kidOf(previous.publicKey);
      const token = await mintAccessToken({ privateKey: previous.privateKey, keyId: previousKid });
      const response = await request(rotatingApp.app).get(JWKS_PATH);

      const published = (response.body as JwkBody).keys.find((key) => key.kid === previousKid);
      const verificationKey = await importJWK(published ?? {}, 'EdDSA');

      await expect(
        jwtVerify(token, verificationKey, {
          algorithms: ['EdDSA'],
          issuer: TEST_ISSUER,
          audience: TEST_AUDIENCE,
        }),
      ).resolves.toBeDefined();
    });

    it('signs every new token with the current key only', async () => {
      const previousKid = await kidOf(previous.publicKey);
      const first = await loginNewUser(rotatingApp, 'rotate-1@example.com');
      const second = await loginNewUser(rotatingApp, 'rotate-2@example.com');
      const response = await request(rotatingApp.app).get(JWKS_PATH);

      for (const token of [first, second]) {
        expect(decodeProtectedHeader(token).kid).toBe(rotatingApp.keyId);
        expect(decodeProtectedHeader(token).kid).not.toBe(previousKid);
        const published = (response.body as JwkBody).keys.find(
          (key) => key.kid === rotatingApp.keyId,
        );
        const currentKey = await importJWK(published ?? {}, 'EdDSA');
        await expect(
          jwtVerify(token, currentKey, { algorithms: ['EdDSA'] }),
        ).resolves.toBeDefined();
      }
      const stale = (response.body as JwkBody).keys.find((key) => key.kid === previousKid);
      const previousKey = await importJWK(stale ?? {}, 'EdDSA');
      await expect(jwtVerify(first, previousKey, { algorithms: ['EdDSA'] })).rejects.toMatchObject({
        code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      });
    });

    it('lets the /me verifier accept a token from the previous key, from the same key set', async () => {
      const user = await rotatingApp.addUser({
        email: 'previous-me@example.com',
        password: PASSWORD,
      });
      const token = await mintAccessToken({
        privateKey: previous.privateKey,
        keyId: await kidOf(previous.publicKey),
        subject: user.id,
        issuedAt: rotatingApp.clock.now(),
      });

      const response = await request(rotatingApp.app)
        .get(ME_PATH)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
    });
  });
});
