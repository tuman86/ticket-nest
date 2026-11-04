import { describe, expect, it } from 'vitest';

import { isSafePath, resolveRoute } from '@/routes/resolve-route';
import { type RouteEntry } from '@/routes/route-table';

const TABLE: readonly RouteEntry[] = [
  { prefix: '/v1/things', upstream: 'catalog' },
  { prefix: '/v1/things/special', upstream: 'auth' },
  { prefix: '/v1/auth', upstream: 'auth' },
];

describe('resolveRoute', () => {
  it.each([
    ['the prefix itself', '/v1/auth'],
    ['a path below it', '/v1/auth/login'],
    ['a deeper path', '/v1/auth/password-reset/confirm'],
    ['a trailing slash', '/v1/auth/'],
  ])('matches %s', (_name, path) => {
    expect(resolveRoute(path, TABLE)?.upstream).toBe('auth');
  });

  it.each(['/v1/authentic', '/v1/au', '/v2/auth', '/auth', '/v1', '/', ''])(
    'does not match %j, because prefixes match whole segments',
    (path) => {
      expect(resolveRoute(path, TABLE)).toBeUndefined();
    },
  );

  it('prefers the longest matching prefix', () => {
    expect(resolveRoute('/v1/things/special/x', TABLE)?.upstream).toBe('auth');
    expect(resolveRoute('/v1/things/other', TABLE)?.upstream).toBe('catalog');
  });

  it('does not depend on the order of the table', () => {
    expect(resolveRoute('/v1/things/special', [...TABLE].reverse())?.upstream).toBe('auth');
  });
});

describe('isSafePath', () => {
  it.each(['/v1/search', '/v1/movies/3f2a9c0e', '/v1/search/caf%C3%A9', '/v1/a.b/c-d_e', '/'])(
    'accepts %s',
    (path) => {
      expect(isSafePath(path)).toBe(true);
    },
  );

  it.each([
    ['a dot segment', '/v1/search/./x'],
    ['a parent segment', '/v1/search/../users/me'],
    ['an encoded parent segment', '/v1/search/%2e%2e/users'],
    ['a mixed-case encoded parent segment', '/v1/search/%2E%2e/users'],
    ['an encoded slash', '/v1/search/a%2fb'],
    ['an encoded backslash', '/v1/search/a%5cb'],
    ['a literal backslash', '/v1/search\\x'],
    ['a null byte', '/v1/search/%00'],
    ['a control character', '/v1/search/%0d%0a'],
    ['a broken percent sequence', '/v1/search/%zz'],
  ])('refuses %s', (_name, path) => {
    expect(isSafePath(path)).toBe(false);
  });
});
