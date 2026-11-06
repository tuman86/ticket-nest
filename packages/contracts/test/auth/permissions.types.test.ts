import { describe, expect, it } from 'vitest';

import { PERMISSION_KEYS, type PermissionKey, isPermissionKey } from '@/auth/permissions';

/**
 * Accepts only a catalogue key. Calling it is how this file checks, at compile time, what a guard
 * such as `requirePermission` will accept.
 *
 * @param key - A permission key.
 * @returns The same key.
 */
function requireKey(key: PermissionKey): PermissionKey {
  return key;
}

/**
 * Stands in for a permission read from a token: typed as a plain `string`, the way a verifier
 * returns it, even though the value happens to be a real key.
 *
 * @returns A permission claim.
 */
function readTokenClaim(): string {
  return 'refund:issue';
}

// `@ts-expect-error` is checked by `tsc` (`pnpm typecheck`), not by Vitest: if a line below ever
// compiles, typecheck fails with "Unused '@ts-expect-error' directive".
describe('PermissionKey', () => {
  it('accepts a catalogue key and refuses anything else at compile time', () => {
    requireKey('role:manage');
    requireKey('booking:read:any');

    // @ts-expect-error A typo is not a catalogue key.
    requireKey('role:mange');
    // @ts-expect-error Keys are lower case.
    requireKey('Role:Manage');
    // @ts-expect-error The self marker is not a permission.
    requireKey('self');
    // @ts-expect-error An unchecked string must be narrowed first.
    requireKey(readTokenClaim());

    expect(PERMISSION_KEYS).toContain('role:manage');
  });

  it('lets a string be narrowed with isPermissionKey', () => {
    const fromToken = readTokenClaim();

    if (!isPermissionKey(fromToken)) throw new Error('expected a catalogue key');

    expect(requireKey(fromToken)).toBe('refund:issue');
  });
});
