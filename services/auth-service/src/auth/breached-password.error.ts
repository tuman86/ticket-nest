import { ValidationError } from '@ticketnest/errors';

const BREACHED_PASSWORD_CODE = 'BREACHED_PASSWORD';

/** 422: the password is on a breached or common-password list. Points at `#/password`. */
export class BreachedPasswordError extends ValidationError {
  constructor() {
    super([
      {
        pointer: '#/password',
        code: BREACHED_PASSWORD_CODE,
        detail: 'This password is too common or appears in known data breaches. Choose another.',
      },
    ]);
  }
}
