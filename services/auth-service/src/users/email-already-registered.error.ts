import { ConflictError, type AppErrorOptions } from '@ticketnest/errors';

const EMAIL_ALREADY_REGISTERED_CODE = 'EMAIL_ALREADY_REGISTERED';

/**
 * 409: a user with this (normalized) email already exists.
 *
 * Callers on public endpoints must not echo this to the client in a way that reveals which emails
 * are registered (see `.claude/rules/security.md`).
 */
export class EmailAlreadyRegisteredError extends ConflictError {
  /**
   * @param options - Extra error options. The machine code is fixed.
   */
  constructor(options: Omit<AppErrorOptions, 'code'> = {}) {
    super({ ...options, code: EMAIL_ALREADY_REGISTERED_CODE });
  }
}
