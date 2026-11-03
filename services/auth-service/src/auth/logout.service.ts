import { type Logger } from '@ticketnest/logger';

import { type RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { type UnitOfWork } from '../repositories/transaction';

import { hashRefreshToken } from './refresh-token-hash';

/** What logout found. For the log only: the caller always gets the same answer. */
type LogoutOutcome = 'revoked' | 'already_revoked' | 'unknown_token';

export interface LogoutServiceDependencies {
  readonly refreshTokenRepository: RefreshTokenRepository;
  readonly unitOfWork: UnitOfWork;
  readonly logger: Logger;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/** Validated logout data. The controller has already parsed the body with Zod. */
export interface LogoutInput {
  /** The raw opaque token. Only ever hashed; never stored or logged. */
  readonly refreshToken: string;
}

/** Business rules for ending a session. */
export class LogoutService {
  private readonly now: () => Date;

  /**
   * @param dependencies - Repository, unit of work and logger, all injected.
   */
  constructor(private readonly dependencies: LogoutServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Ends the session the presented refresh token belongs to by revoking its whole token family
   * (every rotation), in one transaction. The token may be any member of the family, including an
   * old rotated or expired one: possession of any of them proves the session is the caller's.
   *
   * Idempotent and non-revealing: it never throws for an unknown, expired, rotated or revoked
   * token and returns nothing, so the caller cannot learn whether the token was valid. Rows that
   * are already revoked keep their original `revokedAt`. The outcome is logged with ids only.
   *
   * @param input - The raw token.
   */
  async logout(input: LogoutInput): Promise<void> {
    const { refreshTokenRepository, unitOfWork, logger } = this.dependencies;
    const token = await refreshTokenRepository.findByTokenHash(
      hashRefreshToken(input.refreshToken),
    );
    if (token === null) {
      const outcome: LogoutOutcome = 'unknown_token';
      logger.info({ outcome }, 'logout');
      return;
    }
    const revokedCount = await unitOfWork.run((tx) =>
      refreshTokenRepository.revokeFamily(token.familyId, this.now(), tx),
    );
    const outcome: LogoutOutcome = revokedCount > 0 ? 'revoked' : 'already_revoked';
    logger.info(
      { outcome, userId: token.userId, familyId: token.familyId, revokedCount },
      'logout',
    );
  }
}
