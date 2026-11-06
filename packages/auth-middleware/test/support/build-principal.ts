import { randomUUID } from 'node:crypto';

import { type AuthenticatedPrincipal } from '@/authenticated-principal';

/**
 * Builds a verified caller for a test. Without overrides it is a customer with no permissions,
 * no tenant and a login from this moment.
 *
 * @param overrides - Fields to replace.
 * @returns A principal with fresh ids.
 */
export function buildPrincipal(
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    userId: randomUUID(),
    roleKey: 'CUSTOMER',
    permissions: [],
    tenantId: null,
    authTime: new Date(),
    tokenId: randomUUID(),
    ...overrides,
  };
}
