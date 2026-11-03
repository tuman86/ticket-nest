import { describe, expect, it } from 'vitest';

import {
  LOGIN_EMAIL_INPUT_MAX_LENGTH,
  LoginRequest,
  PASSWORD_MAX_LENGTH,
  TokenPair,
} from '@/index';

describe('LoginRequest', () => {
  it('accepts an email and a password', () => {
    expect(LoginRequest.parse({ email: 'asha@example.com', password: 'x' })).toEqual({
      email: 'asha@example.com',
      password: 'x',
    });
  });

  it('trims whitespace around the email before validating it', () => {
    expect(LoginRequest.parse({ email: '  asha@example.com \n', password: 'x' }).email).toBe(
      'asha@example.com',
    );
  });

  it('does not apply the registration password policy to an existing password', () => {
    expect(LoginRequest.safeParse({ email: 'asha@example.com', password: 'short' }).success).toBe(
      true,
    );
  });

  it.each([
    ['a missing email', { password: 'x' }],
    ['a missing password', { email: 'asha@example.com' }],
    ['a non-string password', { email: 'asha@example.com', password: 123 }],
    ['a non-string email', { email: ['asha@example.com'], password: 'x' }],
    ['an empty password', { email: 'asha@example.com', password: '' }],
    ['a malformed email', { email: 'not-an-email', password: 'x' }],
    ['an unknown field', { email: 'asha@example.com', password: 'x', role: 'ADMIN' }],
    [
      'a password over the maximum length',
      { email: 'asha@example.com', password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) },
    ],
    [
      'an oversized email',
      { email: `${'a'.repeat(LOGIN_EMAIL_INPUT_MAX_LENGTH)}@example.com`, password: 'x' },
    ],
  ])('rejects %s', (_name, body) => {
    expect(LoginRequest.safeParse(body).success).toBe(false);
  });
});

describe('TokenPair', () => {
  const tokenPair = {
    accessToken: 'a.b.c',
    refreshToken: 'opaque',
    tokenType: 'Bearer',
    expiresIn: 600,
    refreshExpiresIn: 604_800,
  };

  it('accepts the shape the OpenAPI spec defines', () => {
    expect(TokenPair.parse(tokenPair)).toEqual(tokenPair);
  });

  it('drops fields it does not list, so nothing extra can leak', () => {
    expect(TokenPair.parse({ ...tokenPair, passwordHash: 'secret' })).not.toHaveProperty(
      'passwordHash',
    );
  });
});
