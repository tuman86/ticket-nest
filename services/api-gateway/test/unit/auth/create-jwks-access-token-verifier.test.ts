import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';

import { InvalidAccessTokenError } from '@ticketnest/auth-middleware';
import { createLogger } from '@ticketnest/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { createJwksAccessTokenVerifier } from '@/auth/create-jwks-access-token-verifier';

import { mintAccessToken } from '../../support/mint-access-token';
import {
  getTestPublicKey,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY_ID,
} from '../../support/test-signing-keys';

const JWKS_PATH = '/.well-known/jwks.json';
const closers: (() => Promise<void>)[] = [];

/**
 * Serves auth-service's key set the way the real endpoint does.
 *
 * @param keyId - The `kid` the public key is published under.
 * @returns The full URL of the key set.
 */
async function publishKeys(keyId: string): Promise<string> {
  const jwk = {
    ...getTestPublicKey().export({ format: 'jwk' }),
    kid: keyId,
    use: 'sig',
    alg: 'EdDSA',
  };
  const server = createServer((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'application/jwk-set+json' })
      .end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${JWKS_PATH}`;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('createJwksAccessTokenVerifier', () => {
  it('verifies a token against the keys it fetched from auth-service', async () => {
    const verifier = createJwksAccessTokenVerifier({
      jwksUrl: await publishKeys(TEST_KEY_ID),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      logger: createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' }),
    });
    const token = await mintAccessToken({ subject: '5b0e3a52-3a9b-4f8e-9a45-2b2a1c0d9e11' });

    await expect(verifier.verify(token)).resolves.toMatchObject({
      userId: '5b0e3a52-3a9b-4f8e-9a45-2b2a1c0d9e11',
      roleKey: 'CUSTOMER',
    });
  });

  it('refuses a token whose key id the key set does not publish', async () => {
    const verifier = createJwksAccessTokenVerifier({
      jwksUrl: await publishKeys('some-other-key'),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      logger: createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' }),
    });

    await expect(verifier.verify(await mintAccessToken())).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });

  it('refuses a token for another audience', async () => {
    const verifier = createJwksAccessTokenVerifier({
      jwksUrl: await publishKeys(TEST_KEY_ID),
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      logger: createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' }),
    });
    const token = await mintAccessToken({ audience: 'another-api' });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });
});
