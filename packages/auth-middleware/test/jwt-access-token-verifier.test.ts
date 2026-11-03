import { createPublicKey, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ACCESS_TOKEN_CLOCK_TOLERANCE_MS } from '@/access-token-constants';
import { InvalidAccessTokenError } from '@/invalid-access-token.error';
import { JwtAccessTokenVerifier } from '@/jwt-access-token-verifier';
import { type KeyResolver, KeySetUnavailableError } from '@/key-resolver';
import { StaticKeyResolver } from '@/static-key-resolver';

import {
  forgeUnsignedToken,
  generateRsaPrivateKey,
  mintAccessToken,
  tamperWithPayload,
} from './support/mint-access-token';
import { TestClock } from './support/test-clock';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from './support/test-signing-keys';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const ACCESS_TOKEN_LIFETIME_MS = 10 * MINUTE_MS;

describe('JwtAccessTokenVerifier', () => {
  let keys: TestSigningKeys;
  let clock: TestClock;
  let verifier: JwtAccessTokenVerifier;

  beforeAll(() => {
    keys = generateTestSigningKeys();
    clock = new TestClock();
    verifier = new JwtAccessTokenVerifier({
      keyResolver: new StaticKeyResolver(
        new Map([[TEST_KEY_ID, createPublicKey(keys.privateKey)]]),
      ),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: clock.now,
    });
  });

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

  it('accepts a valid token and returns its claims as the principal', async () => {
    const userId = randomUUID();
    const issuedAt = new Date(Math.floor(clock.now().getTime() / SECOND_MS) * SECOND_MS);
    const token = await mintAccessToken({
      privateKey: keys.privateKey,
      issuedAt,
      subject: userId,
      claims: { role: 'OPERATOR', permissions: ['inventory:create'] },
    });

    const principal = await verifier.verify(token);

    expect(principal).toMatchObject({
      userId,
      roleKey: 'OPERATOR',
      permissions: ['inventory:create'],
      tenantId: null,
      authTime: issuedAt,
    });
    expect(principal.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads tenantId when the token has one', async () => {
    const tenantId = randomUUID();
    const token = await mintAccessToken({ privateKey: keys.privateKey, claims: { tenantId } });

    expect((await verifier.verify(token)).tenantId).toBe(tenantId);
  });

  describe('clock tolerance', () => {
    it('accepts a token that expired within the tolerance', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey });
      clock.advance(ACCESS_TOKEN_LIFETIME_MS + ACCESS_TOKEN_CLOCK_TOLERANCE_MS - SECOND_MS);

      await expect(verifier.verify(token)).resolves.toBeDefined();
      clock.advance(-(ACCESS_TOKEN_LIFETIME_MS + ACCESS_TOKEN_CLOCK_TOLERANCE_MS - SECOND_MS));
    });

    it('refuses a token that expired beyond the tolerance', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey });
      clock.advance(ACCESS_TOKEN_LIFETIME_MS + ACCESS_TOKEN_CLOCK_TOLERANCE_MS + SECOND_MS);

      expect(await reasonFor(token)).toBe('expired');
      clock.advance(-(ACCESS_TOKEN_LIFETIME_MS + ACCESS_TOKEN_CLOCK_TOLERANCE_MS + SECOND_MS));
    });

    it('can be set to zero for a verifier that shares the signer clock', async () => {
      const strictVerifier = new JwtAccessTokenVerifier({
        keyResolver: new StaticKeyResolver(
          new Map([[TEST_KEY_ID, createPublicKey(keys.privateKey)]]),
        ),
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        clockToleranceMs: 0,
        now: clock.now,
      });
      const token = await mintAccessToken({ privateKey: keys.privateKey });
      clock.advance(ACCESS_TOKEN_LIFETIME_MS + SECOND_MS);

      await expect(strictVerifier.verify(token)).rejects.toMatchObject({ reason: 'expired' });
      clock.advance(-(ACCESS_TOKEN_LIFETIME_MS + SECOND_MS));
    });
  });

  describe('refuses with one error type and an internal reason', () => {
    it('tampered payload (signature no longer matches)', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey });

      expect(await reasonFor(tamperWithPayload(token, { role: 'ADMIN' }))).toBe('bad_signature');
    });

    it('token signed by a different key with the right kid', async () => {
      const token = await mintAccessToken({ privateKey: generateTestSigningKeys().privateKey });

      expect(await reasonFor(token)).toBe('bad_signature');
    });

    it('wrong issuer', async () => {
      const token = await mintAccessToken({
        privateKey: keys.privateKey,
        issuer: 'https://evil.example',
      });

      expect(await reasonFor(token)).toBe('wrong_issuer');
    });

    it('wrong audience', async () => {
      const token = await mintAccessToken({
        privateKey: keys.privateKey,
        audience: 'some-other-api',
      });

      expect(await reasonFor(token)).toBe('wrong_audience');
    });

    it('unknown kid', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey, keyId: 'rotated-key-9' });

      expect(await reasonFor(token)).toBe('unknown_key_id');
    });

    it('missing kid', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey, keyId: null });

      expect(await reasonFor(token)).toBe('unknown_key_id');
    });

    it('alg none', async () => {
      const nowSeconds = Math.floor(clock.now().getTime() / SECOND_MS);
      const token = forgeUnsignedToken({
        sub: randomUUID(),
        role: 'ADMIN',
        permissions: [],
        auth_time: 1,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        jti: randomUUID(),
        iat: nowSeconds,
        exp: nowSeconds + 600,
      });

      expect(await reasonFor(token)).toBe('unsupported_algorithm');
    });

    it('HS256 signed with the public key as the secret (algorithm confusion)', async () => {
      const publicPem = createPublicKey(keys.privateKey).export({ type: 'spki', format: 'pem' });
      const token = await mintAccessToken({
        privateKey: new TextEncoder().encode(publicPem),
        algorithm: 'HS256',
      });

      expect(await reasonFor(token)).toBe('unsupported_algorithm');
    });

    it('RS256, which no service signs with', async () => {
      const token = await mintAccessToken({
        privateKey: generateRsaPrivateKey(),
        algorithm: 'RS256',
      });

      expect(await reasonFor(token)).toBe('unsupported_algorithm');
    });

    it('garbage that is not a JWT', async () => {
      for (const garbage of ['x', 'a.b.c', '...']) {
        expect(await reasonFor(garbage)).toBe('malformed_token');
      }
    });

    it('a token without a subject, such as a guest token', async () => {
      const token = await mintAccessToken({
        privateKey: keys.privateKey,
        subject: null,
        claims: { sid: randomUUID() },
      });

      expect(await reasonFor(token)).toBe('invalid_claims');
    });

    it('a token that has a subject and also a guest session id', async () => {
      const token = await mintAccessToken({
        privateKey: keys.privateKey,
        claims: { sid: randomUUID() },
      });

      expect(await reasonFor(token)).toBe('invalid_claims');
    });

    it('a subject that is not a UUID', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey, subject: 'admin' });

      expect(await reasonFor(token)).toBe('invalid_claims');
    });

    it('a token without a role', async () => {
      const token = await mintAccessToken({
        privateKey: keys.privateKey,
        claims: { role: undefined },
      });

      expect(await reasonFor(token)).toBe('invalid_claims');
    });
  });
});

describe('JwtAccessTokenVerifier with a key resolver', () => {
  const keys = generateTestSigningKeys();

  it('never asks the resolver for a key when the algorithm is refused', async () => {
    const resolveKey = vi.fn<KeyResolver['resolveKey']>();
    const verifier = new JwtAccessTokenVerifier({
      keyResolver: { resolveKey },
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const token = await mintAccessToken({
      privateKey: generateRsaPrivateKey(),
      algorithm: 'RS256',
    });

    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'unsupported_algorithm' });
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('asks the resolver for the key the kid header names', async () => {
    const resolveKey = vi
      .fn<KeyResolver['resolveKey']>()
      .mockResolvedValue(createPublicKey(keys.privateKey));
    const verifier = new JwtAccessTokenVerifier({
      keyResolver: { resolveKey },
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const token = await mintAccessToken({ privateKey: keys.privateKey, keyId: 'kid-from-jwks' });

    await expect(verifier.verify(token)).resolves.toBeDefined();
    expect(resolveKey).toHaveBeenCalledExactlyOnceWith('kid-from-jwks');
  });

  it('lets a key set outage through as it is, so it answers 503 and not 401', async () => {
    const outage = new KeySetUnavailableError();
    const verifier = new JwtAccessTokenVerifier({
      keyResolver: { resolveKey: vi.fn<KeyResolver['resolveKey']>().mockRejectedValue(outage) },
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const token = await mintAccessToken({ privateKey: keys.privateKey });

    await expect(verifier.verify(token)).rejects.toBe(outage);
    expect(outage.status).toBe(503);
  });
});
