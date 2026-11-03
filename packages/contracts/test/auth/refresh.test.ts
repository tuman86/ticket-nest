import { describe, expect, it } from 'vitest';

import { REFRESH_TOKEN_MAX_LENGTH, RefreshRequest } from '@/index';

describe('RefreshRequest', () => {
  it('accepts a refresh token', () => {
    expect(RefreshRequest.parse({ refreshToken: 'abc' })).toEqual({ refreshToken: 'abc' });
  });

  it('accepts a token of exactly the maximum length', () => {
    const refreshToken = 'a'.repeat(REFRESH_TOKEN_MAX_LENGTH);

    expect(RefreshRequest.safeParse({ refreshToken }).success).toBe(true);
  });

  it('keeps the limit tight: a real token is 43 characters, so the maximum is well under 1 KB', () => {
    expect(REFRESH_TOKEN_MAX_LENGTH).toBeGreaterThanOrEqual(43);
    expect(REFRESH_TOKEN_MAX_LENGTH).toBeLessThanOrEqual(256);
  });

  it.each([
    ['a missing token', {}],
    ['an empty token', { refreshToken: '' }],
    ['a non-string token', { refreshToken: 12345 }],
    ['an array token', { refreshToken: ['abc'] }],
    ['a token over the maximum length', { refreshToken: 'a'.repeat(REFRESH_TOKEN_MAX_LENGTH + 1) }],
    ['an unknown field', { refreshToken: 'abc', userId: 'someone-else' }],
  ])('rejects %s', (_name, body) => {
    expect(RefreshRequest.safeParse(body).success).toBe(false);
  });
});
