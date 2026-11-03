import { createHash } from 'node:crypto';

import { decodeProtectedHeader, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { EdDsaTokenService } from '@/auth/eddsa-token-service';

import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from '../../support/test-signing-keys';

const USER_ID = '0f8b6d3e-5a0c-4d6b-9b9e-2f7f0f0a1c11';
const TENANT_ID = '5b1d2c3e-7f4a-4a6b-8c9d-0e1f2a3b4c5d';
const AUTH_TIME = new Date('2026-11-03T10:00:00.000Z');
const NOW = new Date('2026-11-03T10:00:30.000Z');
const TEN_MINUTES_SECONDS = 600;
const BASE64URL_256_BITS_LENGTH = 43;

describe('EdDsaTokenService', () => {
  let keys: TestSigningKeys;
  let service: EdDsaTokenService;

  beforeAll(() => {
    keys = generateTestSigningKeys();
    service = new EdDsaTokenService({
      privateKey: keys.privateKey,
      keyId: TEST_KEY_ID,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: () => NOW,
    });
  });

  describe('signAccessToken', () => {
    it('signs a token a verifier with only the public key accepts', async () => {
      const { token, expiresInSeconds } = await service.signAccessToken({
        userId: USER_ID,
        roleKey: 'OPERATOR',
        permissions: ['inventory:create'],
        tenantId: TENANT_ID,
        authTime: AUTH_TIME,
      });

      const { payload } = await jwtVerify(token, keys.publicKey, {
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        algorithms: ['EdDSA'],
        currentDate: NOW,
      });
      expect(expiresInSeconds).toBe(TEN_MINUTES_SECONDS);
      expect(payload).toMatchObject({
        sub: USER_ID,
        role: 'OPERATOR',
        permissions: ['inventory:create'],
        tenantId: TENANT_ID,
        auth_time: AUTH_TIME.getTime() / 1000,
        iat: NOW.getTime() / 1000,
        exp: NOW.getTime() / 1000 + TEN_MINUTES_SECONDS,
      });
      expect(decodeProtectedHeader(token)).toEqual({ alg: 'EdDSA', kid: TEST_KEY_ID });
    });

    it('omits tenantId for a user without a tenant', async () => {
      const { token } = await service.signAccessToken({
        userId: USER_ID,
        roleKey: 'CUSTOMER',
        permissions: [],
        tenantId: null,
        authTime: AUTH_TIME,
      });

      const { payload } = await jwtVerify(token, keys.publicKey, { currentDate: NOW });
      expect(payload).not.toHaveProperty('tenantId');
    });

    it('gives every token its own jti', async () => {
      const claims = {
        userId: USER_ID,
        roleKey: 'CUSTOMER',
        permissions: [],
        tenantId: null,
        authTime: AUTH_TIME,
      };

      const first = await service.signAccessToken(claims);
      const second = await service.signAccessToken(claims);

      const identifiers = await Promise.all(
        [first, second].map(
          async ({ token }) =>
            (await jwtVerify(token, keys.publicKey, { currentDate: NOW })).payload.jti,
        ),
      );
      expect(identifiers[0]).not.toBe(identifiers[1]);
    });

    it('is rejected by a verifier that holds a different key', async () => {
      const { token } = await service.signAccessToken({
        userId: USER_ID,
        roleKey: 'CUSTOMER',
        permissions: [],
        tenantId: null,
        authTime: AUTH_TIME,
      });

      await expect(
        jwtVerify(token, generateTestSigningKeys().publicKey, { currentDate: NOW }),
      ).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
    });

    it('is rejected when the issuer or audience differ', async () => {
      const { token } = await service.signAccessToken({
        userId: USER_ID,
        roleKey: 'CUSTOMER',
        permissions: [],
        tenantId: null,
        authTime: AUTH_TIME,
      });

      await expect(
        jwtVerify(token, keys.publicKey, { issuer: 'someone-else', currentDate: NOW }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
      await expect(
        jwtVerify(token, keys.publicKey, { audience: 'someone-else', currentDate: NOW }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
    });

    it('refuses to sign with a key that is not Ed25519', () => {
      expect(
        () =>
          new EdDsaTokenService({
            privateKey: keys.publicKey,
            keyId: TEST_KEY_ID,
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
          }),
      ).toThrow(TypeError);
    });
  });

  describe('createRefreshToken', () => {
    it('returns a random 256-bit value and the SHA-256 hash of it', () => {
      const { value, hash } = service.createRefreshToken();

      expect(value).toHaveLength(BASE64URL_256_BITS_LENGTH);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(hash).toBe(createHash('sha256').update(value).digest('hex'));
      expect(hash).not.toBe(value);
    });

    it('never repeats a value', () => {
      const values = new Set(Array.from({ length: 50 }, () => service.createRefreshToken().value));

      expect(values.size).toBe(50);
    });
  });
});
