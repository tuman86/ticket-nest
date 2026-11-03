import { createHash } from 'node:crypto';

import { type Jwk } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { JwksService } from '@/auth/jwks.service';
import { createSigningKeySet } from '@/auth/signing-key-set';

import { generateTestSigningKeys } from '../../support/test-signing-keys';

/** @returns The public keys of a throwaway key set with a signing key and one more. */
async function buildPublicJwks(): Promise<readonly Jwk[]> {
  const keySet = await createSigningKeySet({
    privateKey: generateTestSigningKeys().privateKey,
    additionalPublicKeys: [generateTestSigningKeys().publicKey],
  });
  return keySet.publicJwks;
}

describe('JwksService', () => {
  it('serialises the key set once and returns the same document every time', async () => {
    const service = new JwksService(await buildPublicJwks());

    expect(service.getDocument()).toBe(service.getDocument());
    expect(service.getDocument().body).toBe(service.getDocument().body);
  });

  it('puts the keys in a JWK Set and a strong ETag over the exact bytes', async () => {
    const keys = await buildPublicJwks();
    const service = new JwksService(keys);

    const { body, etag } = service.getDocument();

    expect(JSON.parse(body.toString('utf8'))).toEqual({ keys });
    expect(etag).toBe(`"${createHash('sha256').update(body).digest('base64url')}"`);
  });

  it('refuses a key that carries a private member, without echoing its value', async () => {
    const [first] = await buildPublicJwks();
    const leaky = { ...first, d: 'super-secret-private-value' } as unknown as Jwk;

    const attempt = () => new JwksService([leaky]);

    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-private-value');
    }
  });

  it('refuses an empty key set', () => {
    expect(() => new JwksService([])).toThrow();
  });
});
