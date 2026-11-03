import { type TokenPair } from '@ticketnest/contracts';
import { InternalServerError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import {
  type RefreshTokenRecord,
  type RefreshTokenRepository,
} from '../repositories/refresh-token.repository';
import { type RoleRecord, type RoleRepository } from '../repositories/role.repository';
import { type UnitOfWork } from '../repositories/transaction';
import { type UserRecord, type UserRepository } from '../repositories/user.repository';

import { type ClientDetails } from './client-details';
import { InvalidRefreshTokenError } from './invalid-refresh-token.error';
import { hashRefreshToken } from './refresh-token-hash';
import { calculateRefreshExpiry, hasSessionEnded, toTokenPair } from './token-pair';
import { type TokenService } from './token-service';

/** Why a refresh failed. Logged internally, never sent to the caller. */
type RefreshFailureReason =
  'unknown_token' | 'revoked' | 'expired' | 'session_ended' | 'user_inactive' | 'rotation_conflict';

export interface RefreshServiceDependencies {
  readonly userRepository: UserRepository;
  readonly roleRepository: RoleRepository;
  readonly refreshTokenRepository: RefreshTokenRepository;
  readonly unitOfWork: UnitOfWork;
  readonly tokenService: TokenService;
  /**
   * How long after a rotation a replay of the old token counts as a harmless retry (no family
   * revocation, still a 401). 0 turns the window off.
   */
  readonly reuseGraceMs: number;
  readonly logger: Logger;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/** Validated refresh data. The controller has already parsed the body with Zod. */
export interface RefreshInput extends ClientDetails {
  /** The raw opaque token. Only ever hashed; never stored or logged. */
  readonly refreshToken: string;
}

/**
 * Thrown inside the rotation transaction when another request rotated the same token first, so the
 * transaction rolls back and the successor row created a moment earlier disappears. Always caught
 * in this file; it never reaches a client.
 */
class RotationLostError extends Error {
  constructor() {
    super('The refresh token was rotated by a concurrent request.');
    this.name = 'RotationLostError';
  }
}

/** Business rules for exchanging a refresh token for a new token pair. */
export class RefreshService {
  private readonly now: () => Date;

  /**
   * @param dependencies - Repositories, token service, grace window and logger, all injected.
   */
  constructor(private readonly dependencies: RefreshServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Rotates a refresh token: the presented token is marked rotated and a successor in the same
   * family is created, in one transaction, together with a new access token.
   *
   * Concurrency is settled by the database: the rotation is a conditional update (only while the
   * token is neither rotated nor revoked), so of several simultaneous requests with one token
   * exactly one wins and the rest fail without revoking anything.
   *
   * Every failure throws the same error. The reason, and a security event for real reuse, go to
   * the log with user and family ids only.
   *
   * @param input - The raw token and client details.
   * @returns The new access token and refresh token, ready to send.
   * @throws InvalidRefreshTokenError when the token is unknown, expired, revoked, already
   * rotated, past the 30-day session limit, or its user is disabled or gone.
   * @throws InternalServerError when the user's role is missing from the database.
   */
  async refresh(input: RefreshInput): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(input.refreshToken);
    const token = await this.dependencies.refreshTokenRepository.findByTokenHash(tokenHash);
    if (token === null) {
      return this.fail('unknown_token');
    }
    await this.assertUsable(token);
    const { user, role } = await this.loadUserAndRole(token);
    try {
      return await this.rotate(token, user, role, input);
    } catch (error) {
      if (error instanceof RotationLostError) {
        return this.handleLostRace(tokenHash);
      }
      throw error;
    }
  }

  /**
   * Checks that the token may be exchanged. A token that was already rotated is handled as a
   * replay (see `handleRotatedToken`), which never returns.
   *
   * @param token - The stored token.
   * @throws InvalidRefreshTokenError when the token cannot be used.
   */
  private async assertUsable(token: RefreshTokenRecord): Promise<void> {
    const now = this.now();
    if (token.revokedAt !== null) {
      // A revoked token (logout, password change, an earlier reuse) is always a plain failure:
      // there is nothing left to revoke, and it is never given the grace-window treatment.
      return this.fail('revoked', token);
    }
    if (token.rotatedAt !== null) {
      return this.handleRotatedToken(token, token.rotatedAt, now);
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      return this.fail('expired', token);
    }
    if (hasSessionEnded(token.authTime, now)) {
      return this.fail('session_ended', token);
    }
  }

  /**
   * Handles a token that was already exchanged for a successor.
   *
   * Within the grace window (a retry or a second tab) it only fails: the family is left alone.
   * After the window it is treated as theft: the whole family is revoked in its own transaction,
   * which commits before the error is thrown, so the revocation survives the failed request.
   *
   * @param token - The rotated token, not revoked.
   * @param rotatedAt - When it was rotated.
   * @param now - The current time.
   * @throws InvalidRefreshTokenError always.
   */
  private async handleRotatedToken(
    token: RefreshTokenRecord,
    rotatedAt: Date,
    now: Date,
  ): Promise<never> {
    const { logger, unitOfWork, refreshTokenRepository, reuseGraceMs } = this.dependencies;
    const identifiers = { userId: token.userId, familyId: token.familyId };
    if (now.getTime() - rotatedAt.getTime() < reuseGraceMs) {
      logger.info(identifiers, 'refresh replay inside grace window');
      throw new InvalidRefreshTokenError();
    }
    const revokedCount = await unitOfWork.run((tx) =>
      refreshTokenRepository.revokeFamily(token.familyId, now, tx),
    );
    logger.warn(
      { event: 'refresh_token_reuse', ...identifiers, revokedCount },
      'refresh token reuse detected',
    );
    throw new InvalidRefreshTokenError();
  }

  /**
   * Re-reads the user and role from the database, so a role change or a disabled account applies
   * at the next refresh instead of being copied from the old token.
   *
   * @param token - The usable token.
   * @returns The active user and their role.
   * @throws InvalidRefreshTokenError when the user is gone or not `ACTIVE`.
   * @throws InternalServerError when the role is missing.
   */
  private async loadUserAndRole(
    token: RefreshTokenRecord,
  ): Promise<{ user: UserRecord; role: RoleRecord }> {
    const user = await this.dependencies.userRepository.findById(token.userId);
    if (user?.status !== 'ACTIVE') {
      return this.fail('user_inactive', token);
    }
    const role = await this.dependencies.roleRepository.findById(user.roleId);
    if (role === null) {
      throw new InternalServerError({ detail: `Role of user ${user.id} is missing.` });
    }
    return { user, role };
  }

  /**
   * Issues the new pair. Hashing, key use and signing happen before the transaction opens; the
   * transaction holds only the successor insert and the conditional rotation of the old token.
   *
   * @param token - The usable token being exchanged.
   * @param user - Its active user.
   * @param role - The user's current role.
   * @param input - The raw token and client details of this request.
   * @returns The new token pair.
   * @throws RotationLostError when a concurrent request rotated the token first (rolls back).
   */
  private async rotate(
    token: RefreshTokenRecord,
    user: UserRecord,
    role: RoleRecord,
    input: RefreshInput,
  ): Promise<TokenPair> {
    const { tokenService, refreshTokenRepository, unitOfWork, logger } = this.dependencies;
    const now = this.now();
    const successor = tokenService.createRefreshToken();
    const refreshExpiresAt = calculateRefreshExpiry(token.authTime, now);
    const accessToken = await tokenService.signAccessToken({
      userId: user.id,
      roleKey: role.key,
      // Role permissions are not stored yet (they arrive with the permission catalogue seed).
      permissions: [],
      tenantId: user.tenantId,
      // Copied from the stored session, never reset: a refresh is not a password login.
      authTime: token.authTime,
    });

    await unitOfWork.run(async (tx) => {
      // The successor is inserted first because the old row points at it (foreign key).
      const created = await refreshTokenRepository.create(
        {
          userId: user.id,
          familyId: token.familyId,
          tokenHash: successor.hash,
          authTime: token.authTime,
          expiresAt: refreshExpiresAt,
          userAgent: input.userAgent,
          ip: input.ip,
        },
        tx,
      );
      const wasRotated = await refreshTokenRepository.markRotated(token.id, created.id, now, tx);
      if (!wasRotated) {
        throw new RotationLostError();
      }
    });

    logger.info({ userId: user.id, familyId: token.familyId }, 'tokens refreshed');
    return toTokenPair(accessToken, successor.value, refreshExpiresAt, now);
  }

  /**
   * Settles a lost rotation race: looks at the token again, as the winner left it. It is normally
   * rotated just now, so this is a replay inside the grace window and fails without revoking.
   *
   * @param tokenHash - Hash of the presented token.
   * @throws InvalidRefreshTokenError always.
   */
  private async handleLostRace(tokenHash: string): Promise<never> {
    const current = await this.dependencies.refreshTokenRepository.findByTokenHash(tokenHash);
    if (current === null) {
      return this.fail('unknown_token');
    }
    await this.assertUsable(current);
    return this.fail('rotation_conflict', current);
  }

  /**
   * Logs the internal reason (ids only, never a token) and throws the one public error.
   *
   * @param reason - Why the refresh failed, for operators only.
   * @param token - The stored token, when one was found.
   * @throws InvalidRefreshTokenError always.
   */
  private fail(reason: RefreshFailureReason, token?: RefreshTokenRecord): never {
    const identifiers =
      token === undefined ? {} : { userId: token.userId, familyId: token.familyId };
    this.dependencies.logger.info({ reason, ...identifiers }, 'refresh failed');
    throw new InvalidRefreshTokenError();
  }
}
