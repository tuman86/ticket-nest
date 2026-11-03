import { describe, expect, it } from 'vitest';

import {
  LOGIN_POLICY,
  LOGOUT_POLICY,
  REFRESH_POLICY,
  REGISTER_POLICY,
} from '@/rate-limit/rate-limit-policies';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('rate limit policies', () => {
  it('limits register by IP and email per hour and fails closed', () => {
    expect(REGISTER_POLICY).toEqual({
      name: 'register',
      failureMode: 'fail-closed',
      rules: [
        { scope: 'ip', limit: 5, windowMs: ONE_HOUR_MS },
        { scope: 'email', limit: 3, windowMs: ONE_HOUR_MS },
      ],
    });
  });

  it('limits login by IP and email per 15 minutes and fails closed', () => {
    expect(LOGIN_POLICY).toEqual({
      name: 'login',
      failureMode: 'fail-closed',
      rules: [
        { scope: 'ip', limit: 20, windowMs: FIFTEEN_MINUTES_MS },
        { scope: 'email', limit: 10, windowMs: FIFTEEN_MINUTES_MS },
      ],
    });
  });

  it('limits refresh by IP and token per 15 minutes and fails open', () => {
    expect(REFRESH_POLICY).toEqual({
      name: 'refresh',
      failureMode: 'fail-open',
      rules: [
        { scope: 'ip', limit: 60, windowMs: FIFTEEN_MINUTES_MS },
        { scope: 'refresh-token', limit: 20, windowMs: FIFTEEN_MINUTES_MS },
      ],
    });
  });

  it('limits logout by IP only and fails open', () => {
    expect(LOGOUT_POLICY).toEqual({
      name: 'logout',
      failureMode: 'fail-open',
      rules: [{ scope: 'ip', limit: 60, windowMs: FIFTEEN_MINUTES_MS }],
    });
  });

  it('checks the IP rule first, so a blocked IP cannot burn an account counter', () => {
    for (const policy of [REGISTER_POLICY, LOGIN_POLICY, REFRESH_POLICY, LOGOUT_POLICY]) {
      expect(policy.rules[0]?.scope).toBe('ip');
    }
  });
});
