import { UserResponse } from '@ticketnest/contracts';

import { type RoleRecord } from '../repositories/role.repository';
import { type UserRecord } from '../repositories/user.repository';

/**
 * Builds the API `User` from a stored user. Fields are listed one by one (never spread) so a new
 * column, above all `passwordHash`, cannot reach a response by accident. The result is also
 * parsed through `UserResponse`, which drops anything it does not list.
 *
 * @param user - The stored user.
 * @param role - The user's role.
 * @returns The response body.
 */
export function toUserResponse(user: UserRecord, role: RoleRecord): UserResponse {
  return UserResponse.parse({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    name: user.name,
    phone: user.phone,
    role: { id: role.id, key: role.key, name: role.name },
    tenantId: user.tenantId,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
}
