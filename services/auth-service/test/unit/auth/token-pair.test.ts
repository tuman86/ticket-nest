import { describe, expect, it } from 'vitest';

import { calculateRefreshExpiry, hasSessionEnded, toTokenPair } from '@/auth/token-pair';
import { REFRESH_ABSOLUTE_TTL_MS, REFRESH_IDLE_TTL_MS } from '@/auth/token-constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGIN_AT = new Date('2026-11-03T10:00:00.000Z');

describe('calculateRefreshExpiry', () => {
  it('is the idle lifetime from now for a fresh login', () => {
    expect(calculateRefreshExpiry(LOGIN_AT, LOGIN_AT)).toEqual(
      new Date(LOGIN_AT.getTime() + REFRESH_IDLE_TTL_MS),
    );
  });

  it('is the idle lifetime from now while the session is young', () => {
    const now = new Date(LOGIN_AT.getTime() + 3 * DAY_MS);

    expect(calculateRefreshExpiry(LOGIN_AT, now)).toEqual(
      new Date(now.getTime() + REFRESH_IDLE_TTL_MS),
    );
  });

  it('never passes the absolute limit of 30 days from login', () => {
    const now = new Date(LOGIN_AT.getTime() + 28 * DAY_MS);

    expect(calculateRefreshExpiry(LOGIN_AT, now)).toEqual(
      new Date(LOGIN_AT.getTime() + REFRESH_ABSOLUTE_TTL_MS),
    );
  });
});

describe('hasSessionEnded', () => {
  it('is false just before the absolute limit and true at it', () => {
    const limit = LOGIN_AT.getTime() + REFRESH_ABSOLUTE_TTL_MS;

    expect(hasSessionEnded(LOGIN_AT, new Date(limit - 1))).toBe(false);
    expect(hasSessionEnded(LOGIN_AT, new Date(limit))).toBe(true);
  });
});

describe('toTokenPair', () => {
  it('builds the OpenAPI TokenPair with the seconds left on the refresh token', () => {
    const expiresAt = new Date(LOGIN_AT.getTime() + REFRESH_IDLE_TTL_MS);

    expect(
      toTokenPair({ token: 'jwt', expiresInSeconds: 600 }, 'opaque', expiresAt, LOGIN_AT),
    ).toEqual({
      accessToken: 'jwt',
      refreshToken: 'opaque',
      tokenType: 'Bearer',
      expiresIn: 600,
      refreshExpiresIn: 604_800,
    });
  });

  it('reports at least one second, so the response stays a valid TokenPair', () => {
    const pair = toTokenPair(
      { token: 'jwt', expiresInSeconds: 600 },
      'opaque',
      new Date(LOGIN_AT.getTime() + 200),
      LOGIN_AT,
    );

    expect(pair.refreshExpiresIn).toBe(1);
  });
});
