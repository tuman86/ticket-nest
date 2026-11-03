import { randomUUID } from 'node:crypto';

import { type TokenPair } from '@ticketnest/contracts';
import { InternalServerError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import { type RefreshTokenRepository } from '../repositories/refresh-token.repository';
import { type RoleRepository } from '../repositories/role.repository';
import { type UnitOfWork } from '../repositories/transaction';
import { type UserRecord, type UserRepository } from '../repositories/user.repository';
import { normalizeEmail } from '../users/normalize-email';

import { InvalidCredentialsError } from './invalid-credentials.error';
import { type PasswordHasher } from './password-hasher';
import { REFRESH_IDLE_TTL_MS } from './token-constants';
import { type SignedAccessToken, type TokenService } from './token-service';

const MILLISECONDS_PER_SECOND = 1000;

/** Why a login failed. Logged internally, never sent to the caller. */
type LoginFailureReason = 'unknown_user' | 'bad_password' | 'disabled';

export interface LoginServiceDependencies {
  readonly userRepository: UserRepository;
  readonly roleRepository: RoleRepository;
  readonly refreshTokenRepository: RefreshTokenRepository;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly tokenService: TokenService;
  /**
   * A hash made at startup with the current parameters, of a password nobody knows. It is verified
   * when no real hash applies, so an unknown email costs as much time as a known one.
   */
  readonly dummyPasswordHash: string;
  readonly logger: Logger;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
}

/** Validated login data. The controller has already parsed the body with Zod. */
export interface LoginInput {
  /** As typed by the user. The service normalizes it. */
  readonly email: string;
  /** Plaintext. Only ever handed to the hasher. */
  readonly password: string;
  /** `User-Agent`, already truncated to fit its column. */
  readonly userAgent: string | null;
  /** Client IP, already truncated to fit its column. */
  readonly ip: string | null;
}

/** An authenticated user with the data the session needs. */
interface AuthenticatedUser {
  readonly user: UserRecord;
  /** The hash the password was verified against. */
  readonly storedPasswordHash: string;
}

/** Everything `persistSession` writes. */
interface PersistSessionInput {
  readonly user: UserRecord;
  readonly input: LoginInput;
  readonly authTime: Date;
  /** SHA-256 of the new refresh token, lower-case hex. */
  readonly refreshTokenHash: string;
  readonly storedPasswordHash: string;
  /** The stronger hash to store, or null when the stored one is current. */
  readonly upgradedPasswordHash: string | null;
}

/** Business rules for logging in with an email and password. */
export class LoginService {
  private readonly now: () => Date;

  /**
   * @param dependencies - Repositories, hasher, token service, dummy hash and logger, all injected.
   */
  constructor(private readonly dependencies: LoginServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Checks the credentials and starts a new session (a new refresh-token family).
   *
   * Every failure throws the same error, and exactly one hash verification runs in every case
   * (against a dummy hash when there is no usable stored hash), so neither the response nor its
   * timing reveals which emails have accounts. The costly hashing happens before the transaction
   * opens; the transaction holds only the token insert and, when needed, the hash upgrade.
   *
   * @param input - Validated credentials and client details.
   * @returns The access token and refresh token, ready to send.
   * @throws InvalidCredentialsError when the email is unknown, the password is wrong or the user
   * is disabled.
   * @throws InternalServerError when the user's role is missing from the database.
   */
  async login(input: LoginInput): Promise<TokenPair> {
    const { user, storedPasswordHash } = await this.authenticate(input);
    const role = await this.dependencies.roleRepository.findById(user.roleId);
    if (role === null) {
      throw new InternalServerError({ detail: `Role of user ${user.id} is missing.` });
    }

    const authTime = this.now();
    const refreshToken = this.dependencies.tokenService.createRefreshToken();
    const accessToken = await this.dependencies.tokenService.signAccessToken({
      userId: user.id,
      roleKey: role.key,
      // Role permissions are not stored yet (they arrive with the permission catalogue seed).
      permissions: [],
      tenantId: user.tenantId,
      authTime,
    });
    const upgradedPasswordHash = await this.upgradePasswordHashIfWeak(
      input.password,
      storedPasswordHash,
    );

    const familyId = await this.persistSession({
      user,
      input,
      authTime,
      refreshTokenHash: refreshToken.hash,
      storedPasswordHash,
      upgradedPasswordHash,
    });

    // Ids only: never the email, password, hash or either token.
    this.dependencies.logger.info({ userId: user.id, familyId }, 'user logged in');
    return this.toTokenPair(accessToken, refreshToken.value);
  }

  /**
   * Finds the user and verifies the password. Always runs exactly one verification.
   *
   * @param input - The credentials.
   * @returns The active user whose password matched.
   * @throws InvalidCredentialsError for an unknown email, a user without a password, a wrong
   * password or a disabled user.
   */
  private async authenticate(input: LoginInput): Promise<AuthenticatedUser> {
    const { userRepository, passwordHasher } = this.dependencies;
    const user = await userRepository.findByEmail(normalizeEmail(input.email));
    const realPasswordHash = user?.passwordHash ?? null;

    const isPasswordCorrect = await passwordHasher.verify(
      input.password,
      realPasswordHash ?? this.dependencies.dummyPasswordHash,
    );

    if (user === null || realPasswordHash === null) {
      return this.fail('unknown_user');
    }
    if (!isPasswordCorrect) {
      return this.fail('bad_password');
    }
    if (user.status !== 'ACTIVE') {
      return this.fail('disabled');
    }
    return { user, storedPasswordHash: realPasswordHash };
  }

  /**
   * Stores the new session in ONE transaction: the refresh-token row and, when the password hash
   * is being upgraded, the new hash. No network call runs inside it.
   *
   * @param session - What to store.
   * @returns The id of the new token family.
   */
  private async persistSession(session: PersistSessionInput): Promise<string> {
    const { userRepository, refreshTokenRepository, unitOfWork } = this.dependencies;
    const familyId = randomUUID();
    await unitOfWork.run(async (tx) => {
      if (session.upgradedPasswordHash !== null) {
        await userRepository.updatePasswordHashIfUnchanged(
          session.user.id,
          session.storedPasswordHash,
          session.upgradedPasswordHash,
          tx,
        );
      }
      await refreshTokenRepository.create(
        {
          userId: session.user.id,
          familyId,
          tokenHash: session.refreshTokenHash,
          authTime: session.authTime,
          expiresAt: new Date(session.authTime.getTime() + REFRESH_IDLE_TTL_MS),
          userAgent: session.input.userAgent,
          ip: session.input.ip,
        },
        tx,
      );
    });
    return familyId;
  }

  /**
   * Computes a stronger hash when the stored one uses weaker parameters than today's.
   *
   * @param password - The plaintext password that just verified.
   * @param storedPasswordHash - The hash it verified against.
   * @returns The new hash, or null when the stored hash is already current.
   */
  private async upgradePasswordHashIfWeak(
    password: string,
    storedPasswordHash: string,
  ): Promise<string | null> {
    const { passwordHasher } = this.dependencies;
    return passwordHasher.needsRehash(storedPasswordHash) ? passwordHasher.hash(password) : null;
  }

  /**
   * Logs the internal reason (no email, no user id) and throws the one public error.
   *
   * @param reason - Why the login failed, for operators only.
   * @throws InvalidCredentialsError always.
   */
  private fail(reason: LoginFailureReason): never {
    this.dependencies.logger.info({ reason }, 'login failed');
    throw new InvalidCredentialsError();
  }

  /**
   * @param accessToken - The signed access token.
   * @param refreshTokenValue - The opaque refresh token value.
   * @returns The response body defined by the OpenAPI `TokenPair` schema.
   */
  private toTokenPair(accessToken: SignedAccessToken, refreshTokenValue: string): TokenPair {
    return {
      accessToken: accessToken.token,
      refreshToken: refreshTokenValue,
      tokenType: 'Bearer',
      expiresIn: accessToken.expiresInSeconds,
      refreshExpiresIn: REFRESH_IDLE_TTL_MS / MILLISECONDS_PER_SECOND,
    };
  }
}
