import { type AppErrorOptions } from './app-error';
import { UnauthorizedError } from './http-errors';
import { PROBLEM_TYPE_SLUGS } from './problem-types';

/** The one message the error carries. It is the `detail` shown in `common.yaml`. */
export const REAUTHENTICATION_REQUIRED_DETAIL =
  'This action needs a login within the last 5 minutes.';

/**
 * 401: the token is valid, but the operation needs a password login more recent than the token's
 * `auth_time` allows (`x-recent-login: true`, ADR-0025). The client signs in again through
 * `POST /v1/auth/login`; a refresh keeps `auth_time`, so it cannot satisfy this. The detail is
 * fixed so the response never says how old the login was.
 */
export class ReauthenticationRequiredError extends UnauthorizedError {
  /**
   * @param options - Optional cause, kept for the log. The code, title, problem type and detail are fixed.
   */
  constructor(options: Pick<AppErrorOptions, 'cause'> = {}) {
    super({
      ...options,
      detail: REAUTHENTICATION_REQUIRED_DETAIL,
      code: 'REAUTHENTICATION_REQUIRED',
      title: 'Recent login required',
      problemType: PROBLEM_TYPE_SLUGS.reauthenticationRequired,
    });
  }
}
