import { createPublicKey, randomUUID, type KeyObject } from 'node:crypto';

import { createLogger } from '@ticketnest/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpJwksFetcher } from '@/http-jwks-fetcher';
import { InvalidAccessTokenError } from '@/invalid-access-token.error';
import {
  JWKS_CACHE_TTL_MS,
  JWKS_REFETCH_COOLDOWN_MS,
  JWKS_STALE_IF_ERROR_MS,
} from '@/jwks-constants';
import { JwksKeyResolver } from '@/jwks-key-resolver';
import { JwtAccessTokenVerifier } from '@/jwt-access-token-verifier';
import { KeySetUnavailableError } from '@/key-resolver';

import { startFakeJwksServer, type FakeJwksServer } from './support/fake-jwks-server';
import {
  forgeUnsignedToken,
  generateRsaPrivateKey,
  mintAccessToken,
  tamperWithPayload,
} from './support/mint-access-token';
import { TestClock } from './support/test-clock';
import { generateTestSigningKeys, TEST_AUDIENCE, TEST_ISSUER } from './support/test-signing-keys';

const CURRENT_KEY_ID = 'current-key';
const NEXT_KEY_ID = 'next-key';
const MINUTE_MS = 60 * 1000;
const SERVER_ERROR = 500;
/** Keeps "just inside the lifetime" true although `TestClock` follows real time. */
const SAFETY_MARGIN_MS = 1000;

/**
 * These tests run the real `JwtAccessTokenVerifier`, `JwksKeyResolver`, `HttpJwksFetcher` and
 * `jose` against a real HTTP server standing in for auth-service. Only the clock is faked.
 */
describe('access token verification through a JWKS endpoint', () => {
  const current = generateTestSigningKeys();
  const next = generateTestSigningKeys();
  const currentPublicKey = createPublicKey(current.privateKey);
  const nextPublicKey = createPublicKey(next.privateKey);
  let server: FakeJwksServer;
  let clock: TestClock;
  let verifier: JwtAccessTokenVerifier;

  beforeEach(async () => {
    server = await startFakeJwksServer();
    server.publish([{ keyId: CURRENT_KEY_ID, publicKey: currentPublicKey }]);
    clock = new TestClock();
    const logger = createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' });
    verifier = new JwtAccessTokenVerifier({
      keyResolver: new JwksKeyResolver({
        fetcher: new HttpJwksFetcher({ url: server.url }),
        logger,
        now: clock.now,
      }),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: clock.now,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * @param privateKey - The key that signs the token.
   * @param keyId - The `kid` header.
   * @returns A valid access token signed by that key.
   */
  function mintCurrent(privateKey: KeyObject = current.privateKey, keyId = CURRENT_KEY_ID) {
    return mintAccessToken({ privateKey, keyId });
  }

  /**
   * @param token - A compact JWT.
   * @returns The reason the verifier gave for refusing it.
   */
  async function reasonFor(token: string): Promise<string> {
    const error: unknown = await verifier.verify(token).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidAccessTokenError);
    return (error as InvalidAccessTokenError).reason;
  }

  describe('a valid token', () => {
    it('is verified with the key fetched from the endpoint', async () => {
      const userId = randomUUID();
      const token = await mintAccessToken({
        privateKey: current.privateKey,
        keyId: CURRENT_KEY_ID,
        subject: userId,
      });

      await expect(verifier.verify(token)).resolves.toMatchObject({ userId });
      expect(server.requests).toHaveLength(1);
    });

    it('does not ask the endpoint again while the cache is fresh', async () => {
      await verifier.verify(await mintCurrent());
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_CACHE_TTL_MS - SAFETY_MARGIN_MS);
      await verifier.verify(await mintCurrent());

      expect(server.requests).toHaveLength(1);
    });

    it('revalidates with the ETag once the cache is old and keeps the keys on 304', async () => {
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_CACHE_TTL_MS);

      await expect(verifier.verify(await mintCurrent())).resolves.toBeDefined();

      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.ifNoneMatch).toBe('"v1"');
    });
  });

  describe('a token that must be refused', () => {
    it.each([
      ['none', () => forgeUnsignedToken(unsignedClaims())],
      ['RS256', () => mintAccessToken({ privateKey: generateRsaPrivateKey(), algorithm: 'RS256' })],
    ])('with algorithm %s, before any request to the endpoint', async (_name, build) => {
      expect(await reasonFor(await build())).toBe('unsupported_algorithm');
      expect(server.requests).toHaveLength(0);
    });

    it('with the wrong issuer', async () => {
      const token = await mintAccessToken({
        privateKey: current.privateKey,
        keyId: CURRENT_KEY_ID,
        issuer: 'https://evil.example',
      });

      expect(await reasonFor(token)).toBe('wrong_issuer');
    });

    it('with the wrong audience', async () => {
      const token = await mintAccessToken({
        privateKey: current.privateKey,
        keyId: CURRENT_KEY_ID,
        audience: 'some-other-api',
      });

      expect(await reasonFor(token)).toBe('wrong_audience');
    });

    it('that has expired', async () => {
      const token = await mintAccessToken({
        privateKey: current.privateKey,
        keyId: CURRENT_KEY_ID,
        issuedAt: new Date(clock.now().getTime() - 20 * MINUTE_MS),
      });

      expect(await reasonFor(token)).toBe('expired');
    });

    it('with a payload changed after signing', async () => {
      const token = tamperWithPayload(await mintCurrent(), { role: 'ADMIN' });

      expect(await reasonFor(token)).toBe('bad_signature');
    });

    it('signed by a key the endpoint does not publish, under a published kid', async () => {
      expect(await reasonFor(await mintCurrent(next.privateKey))).toBe('bad_signature');
    });

    it.each([
      ['no subject (a guest token)', { subject: null, claims: { sid: randomUUID() } }],
      ['a subject that is not a UUID', { subject: 'admin' }],
      ['no role', { claims: { role: undefined } }],
      ['permissions that are not a list', { claims: { permissions: 'inventory:create' } }],
      ['no auth_time', { claims: { auth_time: undefined } }],
      ['a guest session id next to a subject', { claims: { sid: randomUUID() } }],
    ])('with malformed claims: %s', async (_name, overrides) => {
      const token = await mintAccessToken({
        privateKey: current.privateKey,
        keyId: CURRENT_KEY_ID,
        ...overrides,
      });

      expect(await reasonFor(token)).toBe('invalid_claims');
    });
  });

  describe('a kid the cache does not know', () => {
    beforeEach(async () => {
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);
    });

    it('triggers a refetch and verifies once the key has rotated in', async () => {
      server.publish([
        { keyId: CURRENT_KEY_ID, publicKey: currentPublicKey },
        { keyId: NEXT_KEY_ID, publicKey: nextPublicKey },
      ]);

      await expect(
        verifier.verify(await mintCurrent(next.privateKey, NEXT_KEY_ID)),
      ).resolves.toBeDefined();

      expect(server.requests).toHaveLength(2);
    });

    it('is refused when the endpoint does not publish it either', async () => {
      expect(await reasonFor(await mintCurrent(next.privateKey, NEXT_KEY_ID))).toBe(
        'unknown_key_id',
      );
      expect(server.requests).toHaveLength(2);
    });

    it('is refetched at most once per cooldown, however many forged ids arrive', async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const forged = await mintCurrent(next.privateKey, `forged-${String(attempt)}`);
        expect(await reasonFor(forged)).toBe('unknown_key_id');
      }

      expect(server.requests).toHaveLength(2);
    });

    it('stops being accepted once a rotation removes its key from the endpoint', async () => {
      server.publish([{ keyId: NEXT_KEY_ID, publicKey: nextPublicKey }]);
      await verifier.verify(await mintCurrent(next.privateKey, NEXT_KEY_ID));
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);

      expect(await reasonFor(await mintCurrent())).toBe('unknown_key_id');
    });
  });

  describe('when the endpoint is down', () => {
    it('keeps verifying with the cached keys after the cache is old', async () => {
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_CACHE_TTL_MS);
      server.failWith(SERVER_ERROR);

      await expect(verifier.verify(await mintCurrent())).resolves.toBeDefined();

      expect(server.requests).toHaveLength(2);
    });

    it('does not hammer the endpoint while it is down', async () => {
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_CACHE_TTL_MS);
      server.failWith(SERVER_ERROR);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await verifier.verify(await mintCurrent());
      }

      expect(server.requests).toHaveLength(2);
    });

    it('answers 503, not 401, once the cached keys are older than the stale limit', async () => {
      await verifier.verify(await mintCurrent());
      clock.advance(JWKS_STALE_IF_ERROR_MS + MINUTE_MS);
      server.failWith(SERVER_ERROR);

      const error: unknown = await verifier
        .verify(await mintCurrent())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(KeySetUnavailableError);
      expect((error as KeySetUnavailableError).status).toBe(503);
    });

    it('answers 503 when nothing was ever cached', async () => {
      server.failWith(SERVER_ERROR);

      await expect(verifier.verify(await mintCurrent())).rejects.toBeInstanceOf(
        KeySetUnavailableError,
      );
    });

    it('recovers on the first fetch after the endpoint is back and the cooldown has passed', async () => {
      server.failWith(SERVER_ERROR);
      await verifier.verify(await mintCurrent()).catch(() => undefined);
      server.recover();
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);

      await expect(verifier.verify(await mintCurrent())).resolves.toBeDefined();
    });
  });
});

/** @returns Claims shaped like a user access token, for building an unsigned one. */
function unsignedClaims(): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: randomUUID(),
    role: 'ADMIN',
    permissions: [],
    auth_time: 1,
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + 600,
  };
}
