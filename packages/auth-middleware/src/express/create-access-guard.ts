import { isPermissionKey, type PermissionKey } from '@ticketnest/contracts';
import { ReauthenticationRequiredError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { RECENT_LOGIN_MAX_AGE_MS } from '../access-guard-constants';
import { type AccessRefusalReason } from '../access-scope';
import { type AuthenticatedPrincipal } from '../authenticated-principal';
import { InsufficientPermissionError } from '../insufficient-permission.error';
import { InvalidAccessTokenError } from '../invalid-access-token.error';
import { InvalidGuardConfigurationError } from '../invalid-guard-configuration.error';
import { resolveAccessScope } from '../resolve-access-scope';

import { setAccessScope } from './access-scope-accessors';
import { findAuthenticatedPrincipal } from './authenticated-principal-accessors';
import { readRoutePattern } from './read-route-pattern';

const REFUSAL_LOG_MESSAGE = 'access refused';

/** Why the guard refused a request, for the log. The response never says. */
type GuardRefusalReason = AccessRefusalReason | 'recent_login_required' | 'no_principal';

export interface AccessGuardDependencies {
  readonly logger: Logger;
  /** The clock the age of a login is measured on. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Oldest `auth_time` accepted by a route that needs a recent login. */
  readonly recentLoginMaxAgeMs?: number;
}

/** What one route asks of its caller. */
export interface AccessRequirement {
  /** Keys the route accepts. Holding any one is enough. */
  readonly permissions: readonly [PermissionKey, ...PermissionKey[]];
  /** The operation is marked `x-recent-login: true`. */
  readonly recentLogin?: boolean;
}

/** Builds the guard for one route. */
export type CreateAccessGuard = (requirement: AccessRequirement) => RequestHandler;

/**
 * Refuses a build-time route that names a key outside the catalogue, because such a route would
 * answer 403 to everyone and the typo would only show in production.
 *
 * @param requirement - The route's requirement.
 * @throws InvalidGuardConfigurationError when a key is not in the catalogue.
 */
function assertKnownPermissionKeys(requirement: AccessRequirement): void {
  const keys: readonly unknown[] = requirement.permissions;
  for (const key of keys) {
    if (!isPermissionKey(key)) {
      throw new InvalidGuardConfigurationError(String(key));
    }
  }
}

/**
 * Tells whether the caller's last password login is recent enough. A login exactly at the limit
 * still counts, and a login in the future (clock drift) does too.
 *
 * @param principal - The verified caller.
 * @param now - The current time on the guard's clock.
 * @param maxAgeMs - Oldest accepted login age, in milliseconds.
 * @returns True when `auth_time` is at most `maxAgeMs` old.
 */
function hasRecentLogin(principal: AuthenticatedPrincipal, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - principal.authTime.getTime() <= maxAgeMs;
}

/**
 * Logs one refusal at info level. It carries ids, the reason, the keys the route accepts, the
 * method and the route pattern; never the caller's own permissions or role, and never the raw URL.
 *
 * @param logger - The service logger.
 * @param request - The refused request.
 * @param requirement - The route's requirement.
 * @param reason - Why the request was refused.
 * @param principal - The caller, absent when there was none.
 */
function logRefusal(
  logger: Logger,
  request: Request,
  requirement: AccessRequirement,
  reason: GuardRefusalReason,
  principal?: AuthenticatedPrincipal,
): void {
  logger.info(
    {
      reason,
      ...(principal === undefined ? {} : { userId: principal.userId, tokenId: principal.tokenId }),
      requiredPermissions: [...requirement.permissions],
      method: request.method,
      route: readRoutePattern(request),
    },
    REFUSAL_LOG_MESSAGE,
  );
}

/**
 * Builds the factory of per-route guards (ADR-0025). Authentication is not part of it: the service
 * mounts the authenticate middleware first, and a request that reaches a guard without a caller is
 * answered 401. Checks run in a fixed order, so a caller is never told to sign in again for an
 * action it may not do: the caller (401), then the permission (403), then recent login (401).
 *
 * @param dependencies - The logger, and optionally the clock and the login age limit.
 * @returns A function that builds the guard for one route from its requirement.
 */
export function createAccessGuard(dependencies: AccessGuardDependencies): CreateAccessGuard {
  const {
    logger,
    now = () => new Date(),
    recentLoginMaxAgeMs = RECENT_LOGIN_MAX_AGE_MS,
  } = dependencies;

  return (requirement) => {
    assertKnownPermissionKeys(requirement);
    /**
     * @param request - The incoming request.
     * @param response - Holds the caller and receives the resolved scope.
     * @param next - Called once every check passed.
     * @throws InvalidAccessTokenError when no caller was authenticated.
     * @throws InsufficientPermissionError when the caller holds no usable key.
     * @throws ReauthenticationRequiredError when the route needs a recent login and there is none.
     */
    return (request: Request, response: Response, next: NextFunction): void => {
      const principal = findAuthenticatedPrincipal(response);
      if (principal === undefined) {
        logRefusal(logger, request, requirement, 'no_principal');
        throw new InvalidAccessTokenError('missing_header');
      }
      const resolution = resolveAccessScope(principal, requirement.permissions);
      if (!resolution.isGranted) {
        logRefusal(logger, request, requirement, resolution.reason, principal);
        throw new InsufficientPermissionError(requirement.permissions, resolution.reason);
      }
      if (
        requirement.recentLogin === true &&
        !hasRecentLogin(principal, now(), recentLoginMaxAgeMs)
      ) {
        logRefusal(logger, request, requirement, 'recent_login_required', principal);
        throw new ReauthenticationRequiredError();
      }
      setAccessScope(response, resolution.scope);
      next();
    };
  };
}
