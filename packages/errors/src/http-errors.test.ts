import { describe, expect, it } from 'vitest';

import { AppError } from './app-error';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './http-errors';

describe('http errors', () => {
  it.each([
    [new BadRequestError(), 400, 'MALFORMED_REQUEST', 'malformed-request'],
    [new UnauthorizedError(), 401, 'UNAUTHENTICATED', 'unauthenticated'],
    [new ForbiddenError(), 403, 'FORBIDDEN', 'forbidden'],
    [new NotFoundError(), 404, 'NOT_FOUND', 'not-found'],
    [new ConflictError(), 409, 'CONFLICT', 'conflict'],
    [new InternalServerError(), 500, 'INTERNAL_ERROR', 'internal-error'],
  ])('%s has the documented status, code and problem type', (error, status, code, problemType) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status, code, problemType });
  });

  it('names each error after its class', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
    expect(new ConflictError().name).toBe('ConflictError');
  });

  it('uses the detail as the message, or the title when there is none', () => {
    expect(new NotFoundError({ detail: 'Booking not found.' }).message).toBe('Booking not found.');
    expect(new NotFoundError().message).toBe('Resource not found');
    expect(new NotFoundError().detail).toBeUndefined();
  });

  it('keeps the cause', () => {
    const cause = new Error('root');
    expect(new ConflictError({ cause }).cause).toBe(cause);
  });

  it('lets a domain error override the code by subclassing', () => {
    class SeatUnavailableError extends ConflictError {
      constructor() {
        super({ code: 'SEAT_UNAVAILABLE', detail: 'Seat 4B is taken.' });
      }
    }
    const error = new SeatUnavailableError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      status: 409,
      code: 'SEAT_UNAVAILABLE',
      name: 'SeatUnavailableError',
    });
  });

  it('sends a Bearer challenge on 401 and merges extra headers', () => {
    expect(new UnauthorizedError().headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    expect(new UnauthorizedError({ headers: { 'X-Hint': 'expired' } }).headers).toEqual({
      'WWW-Authenticate': 'Bearer',
      'X-Hint': 'expired',
    });
  });

  it('carries field errors on a ValidationError', () => {
    const fieldErrors = [
      { pointer: '#/email', code: 'INVALID_FORMAT', detail: 'Bad email.' },
    ] as const;
    const error = new ValidationError([...fieldErrors]);

    expect(error.status).toBe(422);
    expect(error.fieldErrors).toEqual(fieldErrors);
    expect(error.extensions).toEqual({ errors: fieldErrors });
    expect(error.detail).toBe('One or more fields are invalid.');
  });
});
