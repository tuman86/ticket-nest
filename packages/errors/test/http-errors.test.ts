import { describe, expect, it } from 'vitest';

import { AppError } from '@/app-error';
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '@/http-errors';

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

  it('lets a domain error override the title, keeping the status of its base class', () => {
    const error = new UnauthorizedError({ title: 'Recent login required' });

    expect(error).toMatchObject({ status: 401, title: 'Recent login required' });
    expect(new UnauthorizedError().title).toBe('Authentication required');
    expect(new UnauthorizedError({ detail: 'Expired.' }).message).toBe('Expired.');
    expect(new UnauthorizedError({ title: 'Recent login required' }).message).toBe(
      'Recent login required',
    );
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

  it('answers 405 with an Allow header listing the accepted methods', () => {
    const error = new MethodNotAllowedError(['GET', 'HEAD'], {
      detail: 'This path does not accept POST.',
    });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      problemType: 'method-not-allowed',
      headers: { Allow: 'GET, HEAD' },
    });
  });

  it('answers 429 with the retry and rate-limit headers from common.yaml', () => {
    const error = new TooManyRequestsError({ limit: 10, retryAfterSeconds: 30 });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      problemType: 'rate-limited',
      detail: 'Rate limit exceeded. Retry after 30 seconds.',
      headers: {
        'Retry-After': '30',
        'RateLimit-Limit': '10',
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '30',
      },
    });
  });

  it.each([
    [new BadGatewayError(), 502, 'BAD_GATEWAY', 'bad-gateway'],
    [new GatewayTimeoutError(), 504, 'GATEWAY_TIMEOUT', 'gateway-timeout'],
  ])('%s has the documented status, code and problem type', (error, status, code, problemType) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status, code, problemType });
  });

  it('answers 503 with a Retry-After header and the documented code', () => {
    const error = new ServiceUnavailableError({ retryAfterSeconds: 5 });

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
      problemType: 'unavailable',
      headers: { 'Retry-After': '5' },
    });
  });
});
