import { describe, expect, it } from 'vitest';

import { DenylistBreachedPasswordChecker } from './denylist-breached-password-checker';

describe('DenylistBreachedPasswordChecker', () => {
  const checker = new DenylistBreachedPasswordChecker();

  it.each(['password123', 'PASSWORD123', 'PassWord123', '1234567890', 'qwertyuiop'])(
    'flags the well-known password %s, ignoring case',
    async (password) => {
      expect(await checker.isBreached(password)).toBe(true);
    },
  );

  it('does not flag an unusual passphrase', async () => {
    expect(await checker.isBreached('correct-horse-battery-staple')).toBe(false);
  });

  it('does not ignore spaces, which can be part of a real password', async () => {
    expect(await checker.isBreached(' password123 ')).toBe(false);
  });

  it('accepts a custom list', async () => {
    const custom = new DenylistBreachedPasswordChecker(['hunter2hunter2']);

    expect(await custom.isBreached('Hunter2Hunter2')).toBe(true);
    expect(await custom.isBreached('password123')).toBe(false);
  });
});
