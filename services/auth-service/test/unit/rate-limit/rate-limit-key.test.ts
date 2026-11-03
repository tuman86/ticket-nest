import { describe, expect, it } from 'vitest';

import { buildRateLimitKey } from '@/rate-limit/rate-limit-key';

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
