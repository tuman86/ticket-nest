import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { StaticKeyResolver } from '@/static-key-resolver';

import { generateTestSigningKeys } from './support/test-signing-keys';

describe('StaticKeyResolver', () => {
  const current = createPublicKey(generateTestSigningKeys().privateKey);
  const previous = createPublicKey(generateTestSigningKeys().privateKey);
  const resolver = new StaticKeyResolver(
    new Map([
      ['current-kid', current],
      ['previous-kid', previous],
    ]),
  );

  it('returns the key a kid names', async () => {
    await expect(resolver.resolveKey('current-kid')).resolves.toBe(current);
    await expect(resolver.resolveKey('previous-kid')).resolves.toBe(previous);
  });

  it('returns undefined for a kid that is not in the set, including inherited object names', async () => {
    for (const keyId of ['unknown-kid', 'constructor', '__proto__', 'toString']) {
      await expect(resolver.resolveKey(keyId)).resolves.toBeUndefined();
    }
  });

  it('refuses an empty set', () => {
    expect(() => new StaticKeyResolver(new Map())).toThrow(TypeError);
  });

  it('refuses a private key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');

    expect(() => new StaticKeyResolver(new Map([['kid', privateKey]]))).toThrow(TypeError);
  });

  it('refuses a key that is not Ed25519', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    expect(() => new StaticKeyResolver(new Map([['kid', publicKey]]))).toThrow(TypeError);
  });
});
