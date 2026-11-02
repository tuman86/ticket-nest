import { ConflictError, type AppErrorOptions } from '@ticketnest/errors';

const EMAIL_ALREADY_REGISTERED_CODE = 'EMAIL_ALREADY_REGISTERED';
const EMAIL_ALREADY_REGISTERED_PROBLEM_TYPE = 'email-already-registered';

/**
 * 409: a user with this (normalized) email already exists.
 *
 * Registration is allowed to answer this (ADR-0013, a documented trade-off, so it must be rate
 * limited). Other public endpoints must not reveal which emails exist (`.claude/rules/security.md`).
 * Never put the email in the error or in a log line.
 */
export class EmailAlreadyRegisteredError extends ConflictError {
  /**
   * @param options - Extra error options. The machine code and problem type are fixed.
   */
  constructor(options: Omit<AppErrorOptions, 'code' | 'problemType'> = {}) {
    super({
      ...options,
      code: EMAIL_ALREADY_REGISTERED_CODE,
      problemType: EMAIL_ALREADY_REGISTERED_PROBLEM_TYPE,
    });
  }
}
