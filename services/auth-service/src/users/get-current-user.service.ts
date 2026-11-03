import { type UserResponse } from '@ticketnest/contracts';
import { InternalServerError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import { InvalidAccessTokenError } from '../auth/invalid-access-token.error';
import { type RoleRepository } from '../repositories/role.repository';
import { type UserRepository } from '../repositories/user.repository';

import { toUserResponse } from './to-user-response';

export interface GetCurrentUserServiceDependencies {
  readonly userRepository: UserRepository;
  readonly roleRepository: RoleRepository;
  readonly logger: Logger;
}

/** Business rules for reading the caller's own profile. */
export class GetCurrentUserService {
  /**
   * @param dependencies - Repositories and logger, all injected.
   */
  constructor(private readonly dependencies: GetCurrentUserServiceDependencies) {}

  /**
   * Loads the caller from the database. Nothing comes from the token's claims except the user id,
   * so a role change, a disabled account or a deleted user is visible immediately.
   *
   * @param userId - The verified `sub` of the access token.
   * @returns The user as the API defines it.
   * @throws InvalidAccessTokenError when the user is gone or not `ACTIVE`: the same 401 as any
   * other invalid access token.
   * @throws InternalServerError when the user's role is missing from the database.
   */
  async getCurrentUser(userId: string): Promise<UserResponse> {
    const { userRepository, roleRepository, logger } = this.dependencies;
    const user = await userRepository.findById(userId);
    if (user?.status !== 'ACTIVE') {
      logger.info({ reason: 'user_inactive', userId }, 'access token rejected');
      throw new InvalidAccessTokenError('user_inactive');
    }
    const role = await roleRepository.findById(user.roleId);
    if (role === null) {
      throw new InternalServerError({ detail: `Role of user ${user.id} is missing.` });
    }
    return toUserResponse(user, role);
  }
}
