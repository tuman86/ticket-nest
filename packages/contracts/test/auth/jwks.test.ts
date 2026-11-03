import { describe, expect, it } from 'vitest';

import { Jwk, Jwks } from '@/auth/jwks';

const PUBLIC_KEY = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  use: 'sig',
  alg: 'EdDSA',
  kid: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
};

describe('Jwk', () => {
  it('accepts a public Ed25519 signing key', () => {
    expect(Jwk.parse(PUBLIC_KEY)).toEqual(PUBLIC_KEY);
  });

  it.each(['d', 'p', 'q', 'dp', 'dq', 'qi'])(
    'rejects a key carrying the private member %s',
    (member) => {
      expect(Jwk.safeParse({ ...PUBLIC_KEY, [member]: 'secret' }).success).toBe(false);
    },
  );

  it.each([
    ['an RSA key', { ...PUBLIC_KEY, kty: 'RSA' }],
    ['another curve', { ...PUBLIC_KEY, crv: 'Ed448' }],
    ['another algorithm', { ...PUBLIC_KEY, alg: 'RS256' }],
    ['an encryption key', { ...PUBLIC_KEY, use: 'enc' }],
    ['a missing kid', { ...PUBLIC_KEY, kid: undefined }],
    ['an empty kid', { ...PUBLIC_KEY, kid: '' }],
  ])('rejects %s', (_name, value) => {
    expect(Jwk.safeParse(value).success).toBe(false);
  });
});

describe('Jwks', () => {
  it('accepts a set with one or more keys', () => {
    expect(Jwks.parse({ keys: [PUBLIC_KEY] }).keys).toHaveLength(1);
  });

  it('rejects an empty set, because a verifier could never accept a token', () => {
    expect(Jwks.safeParse({ keys: [] }).success).toBe(false);
  });

  it('rejects members other than keys', () => {
    expect(Jwks.safeParse({ keys: [PUBLIC_KEY], extra: true }).success).toBe(false);
  });
});
