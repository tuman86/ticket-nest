import { UnauthorizedError } from '@ticketnest/errors';

const INVALID_CREDENTIALS_CODE = 'INVALID_CREDENTIALS';
const INVALID_CREDENTIALS_PROBLEM_TYPE = 'invalid-credentials';

/** The one message every failed login carries. It never says which part was wrong. */
export const INVALID_CREDENTIALS_DETAIL = 'Invalid email or password.';

/**
 * 401: the email or password is wrong, the account does not exist, or it is disabled.
 *
 * All of those must be indistinguishable to the caller (ADR-0013, `.claude/rules/security.md`),
 * so the code, type and detail are fixed here and cannot be overridden.
 */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super({
      code: INVALID_CREDENTIALS_CODE,
      problemType: INVALID_CREDENTIALS_PROBLEM_TYPE,
      detail: INVALID_CREDENTIALS_DETAIL,
    });
  }
}
