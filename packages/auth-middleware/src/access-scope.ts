/**
 * How far a caller's access reaches once the permission guard let it in (ADR-0025, ADR-0015).
 * It comes from the token's `tenantId` alone, never from a role name or a request field.
 */
export type AccessScope =
  /** The token has a `tenantId`: every query is limited to that tenant. */
  | { readonly kind: 'tenant'; readonly tenantId: string }
  /** The token has no `tenantId`: no tenant filter. */
  | { readonly kind: 'all' };

/**
 * Why the guard refused a caller who may have held a matching key. For the server log only; the
 * response always carries the same detail, so a caller cannot learn which rule applied.
 */
export type AccessRefusalReason =
  /** The caller holds none of the keys the route accepts. */
  | 'missing_permission'
  /** The only matching keys end in `:tenant`, and the token has no `tenantId`. */
  | 'tenant_key_without_tenant'
  /** The only matching keys end in `:own`, and the token has no `tenantId`. */
  | 'own_key_without_tenant'
  /** The only matching keys are platform-only, and the token has a `tenantId`. */
  | 'platform_only_with_tenant'
  /** The only matching keys end in a suffix this resolver does not know. */
  | 'unsupported_key_scope';

/** The outcome of resolving a caller against a route's accepted keys. */
export type AccessScopeResolution =
  | { readonly isGranted: true; readonly scope: AccessScope }
  | { readonly isGranted: false; readonly reason: AccessRefusalReason };
