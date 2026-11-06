import { randomUUID } from 'node:crypto';

import { PERMISSION_KEYS, type PermissionKey } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { type AccessScopeResolution } from '@/access-scope';
import { resolveAccessScope } from '@/resolve-access-scope';

import { buildPrincipal } from './support/build-principal';

const TENANT_ID = randomUUID();

/** What a caller holds, which keys the route accepts, and the token's tenant. */
function resolve(
  held: readonly string[],
  required: readonly PermissionKey[],
  tenantId: string | null,
): AccessScopeResolution {
  return resolveAccessScope(buildPrincipal({ permissions: held, tenantId }), required);
}

const TENANT_SCOPE = { isGranted: true, scope: { kind: 'tenant', tenantId: TENANT_ID } } as const;
const ALL_SCOPE = { isGranted: true, scope: { kind: 'all' } } as const;

describe('resolveAccessScope', () => {
  describe('the scope comes from the token tenant alone', () => {
    it.each<[string, PermissionKey]>([
      ['an unscoped key', 'inventory:create'],
      ['an :any key', 'booking:read:any'],
      ['a :tenant key', 'user:read:tenant'],
      ['an :own key', 'operator:read:own'],
    ])('gives tenant scope to a token with a tenantId holding %s', (_label, key) => {
      expect(resolve([key], [key], TENANT_ID)).toEqual(TENANT_SCOPE);
    });

    it.each<[string, PermissionKey]>([
      ['an unscoped key', 'inventory:create'],
      ['an :any key', 'booking:read:any'],
    ])('gives all scope to a token without a tenantId holding %s', (_label, key) => {
      expect(resolve([key], [key], null)).toEqual(ALL_SCOPE);
    });

    it('never widens a tenant token, even when the role holds an :any key', () => {
      expect(resolve(['user:read:any'], ['user:read:any'], TENANT_ID)).toEqual(TENANT_SCOPE);
    });

    it('ignores the role key, so a custom role behaves like a built-in one', () => {
      const withoutPermission = resolveAccessScope(
        buildPrincipal({ roleKey: 'ADMIN', permissions: [] }),
        ['inventory:create'],
      );
      const customRole = resolveAccessScope(
        buildPrincipal({ roleKey: 'FESTIVAL_STAFF', permissions: ['inventory:create'] }),
        ['inventory:create'],
      );

      expect(withoutPermission).toEqual({ isGranted: false, reason: 'missing_permission' });
      expect(customRole).toEqual(ALL_SCOPE);
    });
  });

  describe('a key that names a tenant', () => {
    it('refuses a token without a tenantId', () => {
      expect(resolve(['user:read:tenant'], ['user:read:tenant'], null)).toEqual({
        isGranted: false,
        reason: 'tenant_key_without_tenant',
      });
    });

    it('refuses a token without a tenantId for an :own key as well', () => {
      expect(resolve(['operator:read:own'], ['operator:read:own'], null)).toEqual({
        isGranted: false,
        reason: 'own_key_without_tenant',
      });
    });
  });

  describe('platform-only keys', () => {
    it.each<PermissionKey>(['user:manage', 'role:manage'])(
      'grants %s to a token without a tenantId',
      (key) => {
        expect(resolve([key], [key], null)).toEqual(ALL_SCOPE);
      },
    );

    it.each<PermissionKey>(['user:manage', 'role:manage'])(
      'refuses %s to a token with a tenantId, even when a custom role holds it',
      (key) => {
        expect(resolve([key], [key], TENANT_ID)).toEqual({
          isGranted: false,
          reason: 'platform_only_with_tenant',
        });
      },
    );
  });

  describe('a route that accepts several keys (any-of)', () => {
    const userRead: readonly PermissionKey[] = ['user:read:any', 'user:read:tenant'];

    it('is satisfied by holding either key', () => {
      expect(resolve(['user:read:tenant'], userRead, TENANT_ID)).toEqual(TENANT_SCOPE);
      expect(resolve(['user:read:any'], userRead, TENANT_ID)).toEqual(TENANT_SCOPE);
      expect(resolve(['user:read:any'], userRead, null)).toEqual(ALL_SCOPE);
    });

    it('lets a key that fits the token pass when another held key does not', () => {
      expect(resolve(['user:read:tenant', 'user:read:any'], userRead, null)).toEqual(ALL_SCOPE);
      expect(
        resolve(
          ['user:manage', 'user:read:tenant'],
          ['user:manage', 'user:read:tenant'],
          TENANT_ID,
        ),
      ).toEqual(TENANT_SCOPE);
    });

    it('refuses when every held key is unusable for this token', () => {
      expect(resolve(['user:read:tenant'], userRead, null)).toEqual({
        isGranted: false,
        reason: 'tenant_key_without_tenant',
      });
    });

    it('reports the reason of the first held key in the route order', () => {
      const keys: readonly PermissionKey[] = ['user:read:tenant', 'operator:read:own'];

      expect(resolve(['operator:read:own', 'user:read:tenant'], keys, null)).toEqual({
        isGranted: false,
        reason: 'tenant_key_without_tenant',
      });
    });
  });

  describe('permissions the route does not ask for', () => {
    it('refuses a caller who holds none of the required keys', () => {
      expect(resolve(['inventory:read'], ['inventory:create'], null)).toEqual({
        isGranted: false,
        reason: 'missing_permission',
      });
    });

    it('ignores keys the catalogue does not know, such as one from another version', () => {
      expect(resolve(['legacy:thing', 'inventory:read'], ['inventory:read'], null)).toEqual(
        ALL_SCOPE,
      );
      expect(resolve(['legacy:thing'], ['inventory:read'], null)).toEqual({
        isGranted: false,
        reason: 'missing_permission',
      });
    });

    it('does not use a held key that is not required to decide the scope', () => {
      expect(resolve(['user:read:tenant', 'inventory:read'], ['inventory:read'], null)).toEqual(
        ALL_SCOPE,
      );
    });
  });

  it('refuses a key whose scope suffix it does not recognise, instead of granting it', () => {
    const unknownSuffix = 'widget:read:global' as unknown as PermissionKey;

    expect(resolve([unknownSuffix], [unknownSuffix], null)).toEqual({
      isGranted: false,
      reason: 'unsupported_key_scope',
    });
  });

  describe('the catalogue still fits these rules', () => {
    it('has the scope suffixes the resolver understands, so a new suffix forces a decision', () => {
      const suffixes = new Set(PERMISSION_KEYS.map((key) => key.split(':')[2]));

      expect([...suffixes].sort()).toEqual(['any', 'own', 'tenant', undefined].sort());
    });

    it('has exactly one :own key, so adding another forces a decision on its scope rule', () => {
      // `:own` is treated as "needs a tenantId" because an operator's own record is its tenant.
      // A customer-facing `:own` key (their own booking) would need a different rule.
      expect(PERMISSION_KEYS.filter((key) => key.endsWith(':own'))).toEqual(['operator:read:own']);
    });
  });
});
