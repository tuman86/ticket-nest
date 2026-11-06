import { describe, expect, it } from 'vitest';

import {
  PERMISSION_CATALOGUE,
  PERMISSION_KEY_PATTERN,
  PERMISSION_KEYS,
  PermissionKey,
  isPermissionKey,
} from '@/auth/permissions';

import { readOpenApiOperations } from '../support/read-openapi-operations';
import { readPermissionsDocument } from '../support/read-permissions-doc';

/** Marks operations any signed-in user may perform on their own record. It is never a key. */
const SELF_MARKER = 'self';

const DOCUMENT = readPermissionsDocument();
const OPERATIONS_WITH_PERMISSIONS = [
  ...readOpenApiOperations('auth'),
  ...readOpenApiOperations('catalog'),
].filter((operation) => operation.permissions.length > 0);

/**
 * @param actual - The keys found in the place being checked.
 * @param expected - The keys the catalogue holds.
 * @returns Which keys are missing from `actual` and which `actual` has extra, both sorted, so a
 *   failing test prints exactly what drifted.
 */
function compareKeys(
  actual: readonly string[],
  expected: readonly string[],
): { missing: string[]; unexpected: string[] } {
  return {
    missing: expected.filter((key) => !actual.includes(key)).sort(),
    unexpected: actual.filter((key) => !expected.includes(key)).sort(),
  };
}

/**
 * @param service - The spec to look in.
 * @returns Every key (other than `self`) that some operation of that spec lists.
 */
function keysUsedBy(service: 'auth' | 'catalog'): string[] {
  return OPERATIONS_WITH_PERMISSIONS.filter((operation) => operation.service === service)
    .flatMap((operation) => operation.permissions)
    .filter((key) => key !== SELF_MARKER);
}

describe('permission catalogue', () => {
  it('has unique keys of the documented shape', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) expect(key).toMatch(PERMISSION_KEY_PATTERN);
  });

  it('never lists the self marker, which is not a permission', () => {
    expect(PERMISSION_KEYS).not.toContain(SELF_MARKER);
  });

  it('describes every key in short plain text for a role-editing screen', () => {
    for (const { key, description } of PERMISSION_CATALOGUE) {
      expect(description, key).toMatch(/^[A-Z][^\n*`[\]]{8,118}\.$/);
      expect(description, key).not.toMatch(/assumption|candidate|todo|adr-|\bprd\b/i);
    }
  });

  it('recognises exactly its own keys', () => {
    for (const key of PERMISSION_KEYS) {
      expect(isPermissionKey(key)).toBe(true);
      expect(PermissionKey.safeParse(key).success).toBe(true);
    }
    for (const value of ['self', 'role:manage ', 'ROLE:MANAGE', 'role', '', 42, null, undefined]) {
      expect(isPermissionKey(value)).toBe(false);
      expect(PermissionKey.safeParse(value).success).toBe(false);
    }
  });
});

describe('permission catalogue against docs/permissions.md (keys only)', () => {
  it('lists every catalogue key in section 2, and nothing else', () => {
    const documented = [...DOCUMENT.specified.map(({ key }) => key), ...DOCUMENT.unspecified];

    expect(compareKeys(documented, PERMISSION_KEYS)).toEqual({ missing: [], unexpected: [] });
  });

  it('puts no key in both 2.1 and 2.2', () => {
    const specifiedKeys = DOCUMENT.specified.map(({ key }) => key);

    expect(DOCUMENT.unspecified.filter((key) => specifiedKeys.includes(key))).toEqual([]);
  });

  it('has a row in the default-roles matrix for every catalogue key, and nothing else', () => {
    expect(compareKeys(DOCUMENT.matrix, PERMISSION_KEYS)).toEqual({ missing: [], unexpected: [] });
  });
});

describe('permission catalogue against the OpenAPI specs (x-permissions keys)', () => {
  it('found operations with x-permissions in each spec, so the scan itself is not broken', () => {
    expect(keysUsedBy('auth').length).toBeGreaterThan(0);
    expect(keysUsedBy('catalog').length).toBeGreaterThan(0);
  });

  it('knows every key an operation lists, except the self marker', () => {
    const unknown = OPERATIONS_WITH_PERMISSIONS.flatMap((operation) =>
      operation.permissions
        .filter((key) => key !== SELF_MARKER && !isPermissionKey(key))
        .map((key) => `${operation.method} ${operation.path}: ${key}`),
    );

    expect(unknown).toEqual([]);
  });

  it('lists self alone and never repeats a key within an operation', () => {
    const malformed = OPERATIONS_WITH_PERMISSIONS.filter(
      ({ permissions }) =>
        new Set(permissions).size !== permissions.length ||
        (permissions.includes(SELF_MARKER) && permissions.length > 1),
    ).map((operation) => `${operation.method} ${operation.path}`);

    expect(malformed).toEqual([]);
  });

  it('lists in section 2.1 exactly the keys the specs use', () => {
    const used = [...keysUsedBy('auth'), ...keysUsedBy('catalog')];

    expect(
      compareKeys(
        DOCUMENT.specified.map(({ key }) => key),
        used,
      ),
    ).toEqual({ missing: [], unexpected: [] });
  });

  it('finds each section 2.1 key in the spec its Spec column names', () => {
    const notFound = DOCUMENT.specified
      .filter(({ key, spec }) => !keysUsedBy(spec).includes(key))
      .map(({ key, spec }) => `${key} is not in the ${spec} spec`);

    expect(notFound).toEqual([]);
  });

  it('finds no section 2.2 key in any spec yet', () => {
    const used = [...keysUsedBy('auth'), ...keysUsedBy('catalog')];

    expect(DOCUMENT.unspecified.filter((key) => used.includes(key))).toEqual([]);
  });
});
