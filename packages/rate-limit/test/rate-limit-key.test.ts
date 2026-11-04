import { describe, expect, it } from 'vitest';

import { buildRateLimitKey } from '@/rate-limit-key';

const PEPPER = 'a-test-pepper-that-is-long-enough-1';
const EMAIL = 'ada@example.com';
const REFRESH_TOKEN = 'refresh-token-value-0123456789';

describe('buildRateLimitKey', () => {
  it('keeps the client IP readable, scoped to the policy', () => {
    expect(
      buildRateLimitKey({
        policyName: 'login',
        scope: 'ip',
        identifier: '203.0.113.7',
        pepper: PEPPER,
      }),
    ).toBe('rl:v1:login:ip:203.0.113.7');
  });

  it.each([
    ['email', EMAIL],
    ['refresh-token', REFRESH_TOKEN],
  ] as const)('never puts the plaintext %s in the key', (scope, identifier) => {
    const key = buildRateLimitKey({ policyName: 'login', scope, identifier, pepper: PEPPER });

    expect(key).not.toContain(identifier);
    expect(key).not.toContain(PEPPER);
    expect(key).toMatch(new RegExp(`^rl:v1:login:${scope}:[0-9a-f]{64}$`));
  });

  it('gives the same key for the same input', () => {
    const input = {
      policyName: 'login',
      scope: 'email',
      identifier: EMAIL,
      pepper: PEPPER,
    } as const;

    expect(buildRateLimitKey(input)).toBe(buildRateLimitKey({ ...input }));
  });

  it('gives a different key per pepper, policy and identifier', () => {
    const base = {
      policyName: 'login',
      scope: 'email',
      identifier: EMAIL,
      pepper: PEPPER,
    } as const;
    const keys = new Set([
      buildRateLimitKey(base),
      buildRateLimitKey({ ...base, pepper: `${PEPPER}-rotated` }),
      buildRateLimitKey({ ...base, policyName: 'register' }),
      buildRateLimitKey({ ...base, identifier: 'grace@example.com' }),
    ]);

    expect(keys.size).toBe(4);
  });

  it('keeps an email and a refresh token with the same text apart', () => {
    const shared = 'same-text';
    const emailKey = buildRateLimitKey({
      policyName: 'login',
      scope: 'email',
      identifier: shared,
      pepper: PEPPER,
    });
    const tokenKey = buildRateLimitKey({
      policyName: 'login',
      scope: 'refresh-token',
      identifier: shared,
      pepper: PEPPER,
    });

    expect(emailKey.split(':').at(-1)).not.toBe(tokenKey.split(':').at(-1));
  });
});

describe('buildRateLimitKey scopes', () => {
  const USER_ID = '7f0c2f0e-8d3b-4a53-9a0e-2f1d9a3d5c11';

  it('keeps a user id readable and needs no pepper for it', () => {
    expect(
      buildRateLimitKey({ policyName: 'gateway-user', scope: 'user', identifier: USER_ID }),
    ).toBe(`rl:v1:gateway-user:user:${USER_ID}`);
  });

  it('refuses to build a key for a hashed scope without a pepper', () => {
    expect(() =>
      buildRateLimitKey({ policyName: 'login', scope: 'email', identifier: EMAIL }),
    ).toThrow(/pepper/);
  });

  it('hashes a scope it does not know, so a new scope is safe by default', () => {
    const key = buildRateLimitKey({
      policyName: 'login',
      scope: 'phone',
      identifier: '+15555550100',
      pepper: PEPPER,
    });

    expect(key).not.toContain('+15555550100');
    expect(key).toMatch(/^rl:v1:login:phone:[0-9a-f]{64}$/);
  });
});
