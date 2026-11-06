import { type PermissionKey } from '@ticketnest/contracts';

import {
  type AccessRefusalReason,
  type AccessScope,
  type AccessScopeResolution,
} from './access-scope';
import { type AuthenticatedPrincipal } from './authenticated-principal';

/**
 * Keys only a caller without a tenant may use, even when a custom role holds them. Until ADR-0025
 * "Still open" decides whether a tenant-bound caller may manage the users of its own tenant, a
 * token with a `tenantId` never counts these. A local list, not a catalogue field, so the
 * five-place rule for a new key stays as it is.
 */
const PLATFORM_ONLY_KEYS: readonly PermissionKey[] = ['user:manage', 'role:manage'];

/** The suffix of a key, which can only narrow access (ADR-0025). */
type KeyScopeSuffix = 'unscoped' | 'any' | 'tenant' | 'own' | 'unsupported';

/**
 * Reads the scope suffix of a key (`resource:action[:suffix]`).
 *
 * @param key - A permission key.
 * @returns The suffix kind, or `unsupported` for a suffix this resolver does not know.
 */
function readKeyScopeSuffix(key: PermissionKey): KeyScopeSuffix {
  switch (key.split(':')[2]) {
    case undefined:
      return 'unscoped';
    case 'any':
      return 'any';
    case 'tenant':
      return 'tenant';
    case 'own':
      return 'own';
    default:
      return 'unsupported';
  }
}

/**
 * Tells why a held key cannot be used by a token, if it cannot.
 *
 * @param key - A key the caller holds and the route accepts.
 * @param hasTenant - Whether the token carries a `tenantId`.
 * @returns The reason the key is unusable, or `undefined` when it is usable.
 */
function findKeyRefusal(key: PermissionKey, hasTenant: boolean): AccessRefusalReason | undefined {
  if (hasTenant && PLATFORM_ONLY_KEYS.includes(key)) {
    return 'platform_only_with_tenant';
  }
  const suffix = readKeyScopeSuffix(key);
  if (suffix === 'unsupported') {
    return 'unsupported_key_scope';
  }
  if (!hasTenant && suffix === 'tenant') {
    return 'tenant_key_without_tenant';
  }
  // An `:own` key acts on the caller's own record; the only one today is an operator's own
  // operator record, which is its tenant, so it needs a tenantId like a `:tenant` key does.
  if (!hasTenant && suffix === 'own') {
    return 'own_key_without_tenant';
  }
  return undefined;
}

/**
 * Builds the scope for a token: the tenant when it has one, otherwise everything. The key's suffix
 * never changes the result, so a wide key in an editable role cannot widen a tenant token.
 *
 * @param principal - The verified caller.
 * @returns The scope the route's handler must stay within.
 */
function buildScope(principal: AuthenticatedPrincipal): AccessScope {
  return principal.tenantId === null
    ? { kind: 'all' }
    : { kind: 'tenant', tenantId: principal.tenantId };
}

/**
 * Decides whether a caller holds a permission the route accepts, and how far that reaches. A route
 * lists several keys as any-of: one usable key is enough. The decision reads only the token, never
 * the role key or a request field (ADR-0025, ADR-0015).
 *
 * @param principal - The verified caller; `permissions` may hold keys this catalogue version lacks.
 * @param requiredKeys - The keys the route accepts, at least one.
 * @returns The scope when a held key is usable by this token, otherwise the reason for the log.
 * When several held keys are unusable, the reason is that of the first one in `requiredKeys` order.
 */
export function resolveAccessScope(
  principal: AuthenticatedPrincipal,
  requiredKeys: readonly PermissionKey[],
): AccessScopeResolution {
  const heldPermissions = new Set(principal.permissions);
  const heldKeys = requiredKeys.filter((key) => heldPermissions.has(key));
  let firstRefusal: AccessRefusalReason | undefined;

  for (const key of heldKeys) {
    const refusal = findKeyRefusal(key, principal.tenantId !== null);
    if (refusal === undefined) {
      return { isGranted: true, scope: buildScope(principal) };
    }
    firstRefusal ??= refusal;
  }
  return { isGranted: false, reason: firstRefusal ?? 'missing_permission' };
}
