import { describe, expect, it } from 'vitest';

import { isKnownClientIp, readClientIp } from '@/client-ip';

describe('readClientIp', () => {
  it('puts a request with no known IP in one shared bucket instead of skipping the IP rule', () => {
    expect(readClientIp(undefined)).toBe('unknown');
    expect(readClientIp('')).toBe('unknown');
  });

  it.each(['203.0.113.7', '2001:db8::1', '::1', '::ffff:127.0.0.1'])(
    'keeps the valid address %s',
    (ip) => {
      expect(readClientIp(ip)).toBe(ip);
    },
  );

  it('drops the zone id of a link-local address, so one client has one key', () => {
    expect(readClientIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it.each([
    ['text', 'not an ip'],
    ['a forwarded list', '203.0.113.7, 198.51.100.1'],
    ['a key-shaped string', 'x:email:abcdef'],
    ['an out-of-range address', '999.1.1.1'],
    ['a very long string', 'a'.repeat(5_000)],
  ])('puts %s in the shared unknown bucket instead of into a key', (_name, ip) => {
    expect(readClientIp(ip)).toBe('unknown');
  });
});

describe('isKnownClientIp', () => {
  it('is true for an address and false for the unknown bucket', () => {
    expect(isKnownClientIp(readClientIp('203.0.113.7'))).toBe(true);
    expect(isKnownClientIp(readClientIp(undefined))).toBe(false);
    expect(isKnownClientIp(readClientIp('not an ip'))).toBe(false);
  });
});
