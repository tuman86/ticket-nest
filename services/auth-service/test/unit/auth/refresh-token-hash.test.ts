import { describe, expect, it } from 'vitest';

import { hashRefreshToken } from '@/auth/refresh-token-hash';

describe('hashRefreshToken', () => {
  it('returns the lower-case hex SHA-256 digest (RFC 6234 test vector for "abc")', () => {
    expect(hashRefreshToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic and gives different output for different input', () => {
    expect(hashRefreshToken('a')).toBe(hashRefreshToken('a'));
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });
});
