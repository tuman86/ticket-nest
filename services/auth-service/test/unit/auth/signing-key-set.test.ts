import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

import { ConfigError } from '@ticketnest/config';
import { describe, expect, it } from 'vitest';

import { createSigningKeySet } from '@/auth/signing-key-set';

import { generateTestSigningKeys } from '../../support/test-signing-keys';

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

/** RFC 8037 appendix A: the example Ed25519 key and the thumbprint RFC 7638 gives it (A.3). */
const RFC_8037_PRIVATE_D = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
const RFC_8037_PUBLIC_X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const RFC_8037_THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';

/**
 * @param publicKey - An Ed25519 public key.
 * @returns Its RFC 7638 thumbprint, computed by hand from the canonical JSON, independent of jose.
 */
function thumbprintOf(publicKey: KeyObject): string {
  const { x } = publicKey.export({ format: 'jwk' });
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x ?? ''}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

describe('createSigningKeySet', () => {
  it('derives the kid from the public key, matching the RFC 8037 / RFC 7638 example', async () => {
    const privateKey = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: RFC_8037_PRIVATE_D, x: RFC_8037_PUBLIC_X },
      format: 'jwk',
    });

    const keySet = await createSigningKeySet({ privateKey, additionalPublicKeys: [] });

    expect(keySet.signingKeyId).toBe(RFC_8037_THUMBPRINT);
    expect(keySet.publicJwks).toEqual([
      {
        kty: 'OKP',
        crv: 'Ed25519',
        x: RFC_8037_PUBLIC_X,
        use: 'sig',
        alg: 'EdDSA',
        kid: RFC_8037_THUMBPRINT,
      },
    ]);
  });

  it('gives a random key the kid its canonical JSON hashes to', async () => {
    const { privateKey } = generateTestSigningKeys();

    const keySet = await createSigningKeySet({ privateKey, additionalPublicKeys: [] });

    expect(keySet.signingKeyId).toBe(thumbprintOf(createPublicKey(privateKey)));
  });

  it('keeps the signing private key and exposes only public keys for verification', async () => {
    const current = generateTestSigningKeys();
    const upcoming = generateTestSigningKeys();

    const keySet = await createSigningKeySet({
      privateKey: current.privateKey,
      additionalPublicKeys: [upcoming.publicKey],
    });

    expect(keySet.signingPrivateKey).toBe(current.privateKey);
    expect([...keySet.verificationKeys.keys()].sort()).toEqual(
      [thumbprintOf(current.publicKey), thumbprintOf(upcoming.publicKey)].sort(),
    );
    for (const key of keySet.verificationKeys.values()) {
      expect(key.type).toBe('public');
      expect(key.asymmetricKeyType).toBe('ed25519');
    }
  });

  it('lists the signing key first, then the others sorted by kid, whatever order they came in', async () => {
    const current = generateTestSigningKeys();
    const others = [
      generateTestSigningKeys(),
      generateTestSigningKeys(),
      generateTestSigningKeys(),
    ];

    const forward = await createSigningKeySet({
      privateKey: current.privateKey,
      additionalPublicKeys: others.map((pair) => pair.publicKey),
    });
    const backward = await createSigningKeySet({
      privateKey: current.privateKey,
      additionalPublicKeys: others.map((pair) => pair.publicKey).reverse(),
    });

    const kids = forward.publicJwks.map((jwk) => jwk.kid);
    expect(kids[0]).toBe(forward.signingKeyId);
    expect(kids.slice(1)).toEqual([...kids.slice(1)].sort());
    expect(backward.publicJwks).toEqual(forward.publicJwks);
  });

  it('publishes no private member for any key', async () => {
    const keySet = await createSigningKeySet({
      privateKey: generateTestSigningKeys().privateKey,
      additionalPublicKeys: [generateTestSigningKeys().publicKey],
    });

    for (const jwk of keySet.publicJwks) {
      for (const member of PRIVATE_MEMBERS) {
        expect(jwk).not.toHaveProperty(member);
      }
    }
  });

  describe('refuses a key set it cannot publish safely', () => {
    it('rejects an additional key equal to the signing key', async () => {
      const { privateKey } = generateTestSigningKeys();

      await expect(
        createSigningKeySet({
          privateKey,
          additionalPublicKeys: [createPublicKey(privateKey)],
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    it('rejects an additional key that is a private key', async () => {
      await expect(
        createSigningKeySet({
          privateKey: generateTestSigningKeys().privateKey,
          additionalPublicKeys: [generateTestSigningKeys().privateKey],
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    it('rejects an additional key of another type, without echoing key material', async () => {
      const { publicKey: rsaPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

      const failure: unknown = await createSigningKeySet({
        privateKey: generateTestSigningKeys().privateKey,
        additionalPublicKeys: [rsaPublicKey],
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(failure).toBeInstanceOf(ConfigError);
      const exported = rsaPublicKey.export({ type: 'spki', format: 'pem' });
      expect((failure as ConfigError).message).not.toContain(
        exported.split('\n')[1] ?? 'unreachable',
      );
    });
  });
});
