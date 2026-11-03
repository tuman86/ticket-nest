import { describe, expect, it } from 'vitest';

import { readRateLimitIdentifiers } from '@/rate-limit/rate-limit-identifiers';

describe('readRateLimitIdentifiers', () => {
  it('reads the IP, the normalized email and the refresh token', () => {
    expect(
      readRateLimitIdentifiers({
        ip: '203.0.113.7',
        body: { email: '  Ada@Example.COM ', refreshToken: 'token-value' },
      }),
    ).toEqual({ ip: '203.0.113.7', email: 'ada@example.com', 'refresh-token': 'token-value' });
  });

  it('puts a request with no known IP in one shared bucket instead of skipping the IP rule', () => {
    expect(readRateLimitIdentifiers({ ip: undefined, body: {} }).ip).toBe('unknown');
    expect(readRateLimitIdentifiers({ ip: '', body: {} }).ip).toBe('unknown');
  });

  it.each(['203.0.113.7', '2001:db8::1', '::1', '::ffff:127.0.0.1'])(
    'keeps the valid address %s',
    (ip) => {
      expect(readRateLimitIdentifiers({ ip, body: {} }).ip).toBe(ip);
    },
  );

  it('drops the zone id of a link-local address, so one client has one key', () => {
    expect(readRateLimitIdentifiers({ ip: 'fe80::1%eth0', body: {} }).ip).toBe('fe80::1');
  });

  it.each([
    ['text', 'not an ip'],
    ['a forwarded list', '203.0.113.7, 198.51.100.1'],
    ['a key-shaped string', 'x:email:abcdef'],
    ['an out-of-range address', '999.1.1.1'],
    ['a very long string', 'a'.repeat(5_000)],
  ])('puts %s in the shared unknown bucket instead of into a key', (_name, ip) => {
    expect(readRateLimitIdentifiers({ ip, body: {} }).ip).toBe('unknown');
  });

  it.each([
    ['no body', undefined],
    ['a non-object body', 'text'],
    ['an array body', ['a@example.com']],
    ['a non-string email', { email: 42 }],
    ['an empty email', { email: '   ' }],
    ['a non-string token', { refreshToken: { nested: true } }],
    ['an empty token', { refreshToken: '' }],
  ])('leaves out the account identifiers for %s', (_name, body) => {
    expect(readRateLimitIdentifiers({ ip: '203.0.113.7', body })).toEqual({ ip: '203.0.113.7' });
  });

  it('ignores unknown body fields', () => {
    expect(
      readRateLimitIdentifiers({
        ip: '203.0.113.7',
        body: { email: 'a@example.com', role: 'ADMIN' },
      }),
    ).toEqual({ ip: '203.0.113.7', email: 'a@example.com' });
  });
});
