import { createPublicKey, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { EdDsaAccessTokenVerifier } from '@/auth/eddsa-access-token-verifier';
import { EdDsaTokenService } from '@/auth/eddsa-token-service';
import { InvalidAccessTokenError } from '@/auth/invalid-access-token.error';

import {
  forgeUnsignedToken,
  generateRsaPrivateKey,
  mintAccessToken,
  tamperWithPayload,
} from '../../support/mint-access-token';
import { TestClock } from '../../support/test-clock';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from '../../support/test-signing-keys';

const MINUTE_MS = 60 * 1000;
const ACCESS_TOKEN_LIFETIME_MS = 10 * MINUTE_MS;

describe('EdDsaAccessTokenVerifier', () => {
  let keys: TestSigningKeys;
  let clock: TestClock;
  let verifier: EdDsaAccessTokenVerifier;

  beforeAll(() => {
    keys = generateTestSigningKeys();
    clock = new TestClock();
    verifier = new EdDsaAccessTokenVerifier({
      publicKey: createPublicKey(keys.privateKey),
      keyId: TEST_KEY_ID,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: clock.now,
    });
  });

  /**
   * @param verifyingToken - A compact JWT.
   * @returns The reason the verifier gave for refusing it.
   */
  async function reasonFor(verifyingToken: string): Promise<string> {
    const error: unknown = await verifier.verify(verifyingToken).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidAccessTokenError);
    return (error as InvalidAccessTokenError).reason;
  }

  it('accepts a token made by EdDsaTokenService and returns its claims', async () => {
    const signer = new EdDsaTokenService({
      privateKey: keys.privateKey,
      keyId: TEST_KEY_ID,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: clock.now,
    });
    const userId = randomUUID();
    const authTime = new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
    const { token } = await signer.signAccessToken({
      userId,
      roleKey: 'OPERATOR',
      permissions: ['inventory:create'],
      tenantId: null,
      authTime,
    });

    const principal = await verifier.verify(token);

    expect(principal).toMatchObject({
      userId,
      roleKey: 'OPERATOR',
      permissions: ['inventory:create'],
      tenantId: null,
      authTime,
    });
    expect(principal.tokenId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads tenantId when the token has one', async () => {
    const tenantId = randomUUID();
    const token = await mintAccessToken({ privateKey: keys.privateKey, claims: { tenantId } });

    expect((await verifier.verify(token)).tenantId).toBe(tenantId);
  });

  describe('refuses with one error type and an internal reason', () => {
    it('expired token', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey });
      clock.advance(ACCESS_TOKEN_LIFETIME_MS + MINUTE_MS);

      expect(await reasonFor(token)).toBe('expired');
      clock.advance(-(ACCESS_TOKEN_LIFETIME_MS + MINUTE_MS));
    });

    it('tampered payload (signature no longer matches)', async () => {
      const token = await mintAccessToken({ privateKey: keys.privateKey });

      expect(await reasonFor(tamperWithPayload(token, { role: 'ADMIN' }))).toBe('bad_signature');
    });

    it('token signed by a different key with the right kid', async () => {
      const token = await mintAccessToken({
        privateKey: generateTestSigningKeys().privateKey,
      });

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
      const token = forgeUnsignedToken({
        sub: randomUUID(),
        role: 'ADMIN',
        permissions: [],
        auth_time: 1,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        jti: randomUUID(),
        iat: Math.floor(clock.now().getTime() / 1000),
        exp: Math.floor(clock.now().getTime() / 1000) + 600,
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

    it('RS256, which this service never signs with', async () => {
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
