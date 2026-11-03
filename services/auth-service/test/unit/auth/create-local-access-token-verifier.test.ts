import { createPublicKey } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { createLocalAccessTokenVerifier } from '@/auth/create-local-access-token-verifier';

import { mintAccessToken } from '../../support/mint-access-token';
import { TestClock } from '../../support/test-clock';
import {
  generateTestSigningKeys,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
  type TestSigningKeys,
} from '../../support/test-signing-keys';

const SECOND_MS = 1000;
const ACCESS_TOKEN_LIFETIME_MS = 10 * 60 * SECOND_MS;
/** Longer than the shared verifier's default tolerance, so a leftover default would accept it. */
const EXPIRED_FOR_MS = 3 * SECOND_MS;

describe('createLocalAccessTokenVerifier', () => {
  let keys: TestSigningKeys;
  let clock: TestClock;
  let verifier: ReturnType<typeof createLocalAccessTokenVerifier>;

  beforeAll(() => {
    keys = generateTestSigningKeys();
    clock = new TestClock();
    verifier = createLocalAccessTokenVerifier({
      verificationKeys: new Map([[TEST_KEY_ID, createPublicKey(keys.privateKey)]]),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      now: clock.now,
    });
  });

  it('accepts a token signed by one of its keys', async () => {
    const token = await mintAccessToken({ privateKey: keys.privateKey });

    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it('refuses a token as soon as it has expired: the signer and the verifier share one clock', async () => {
    const token = await mintAccessToken({
      privateKey: keys.privateKey,
      issuedAt: new Date(clock.now().getTime() - ACCESS_TOKEN_LIFETIME_MS - EXPIRED_FOR_MS),
    });

    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('refuses a token signed by a key it does not hold', async () => {
    const token = await mintAccessToken({
      privateKey: generateTestSigningKeys().privateKey,
    });

    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'bad_signature' });
  });
});
