import { Problem, ValidationProblem } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { ConflictError, InternalServerError, NotFoundError, ValidationError } from './http-errors';
import { toProblem } from './to-problem';

describe('toProblem', () => {
  it('builds a Problem with type URL, title, status and code', () => {
    const problem = toProblem(new NotFoundError({ detail: 'Booking not found.' }), {
      instance: '/v1/bookings/1',
      correlationId: 'corr-1',
    });

    expect(Problem.parse(problem)).toEqual({
      type: 'https://api.ticketnest.example/problems/not-found',
      title: 'Resource not found',
      status: 404,
      detail: 'Booking not found.',
      code: 'NOT_FOUND',
      instance: '/v1/bookings/1',
      correlationId: 'corr-1',
    });
  });

  it('uses a domain problem type when the error sets one, and keeps its status and title', () => {
    const problem = toProblem(
      new ConflictError({
        code: 'EMAIL_ALREADY_REGISTERED',
        problemType: 'email-already-registered',
      }),
    );

    expect(problem).toEqual({
      type: 'https://api.ticketnest.example/problems/email-already-registered',
      title: 'Conflict',
      status: 409,
      code: 'EMAIL_ALREADY_REGISTERED',
    });
  });

  it('omits detail, instance and correlationId when absent', () => {
    expect(toProblem(new ConflictError())).toEqual({
      type: 'https://api.ticketnest.example/problems/conflict',
      title: 'Conflict',
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('includes the errors array and validates as a ValidationProblem', () => {
    const problem = toProblem(
      new ValidationError([{ pointer: '#/email', code: 'INVALID_FORMAT', detail: 'Bad email.' }]),
    );

    expect(ValidationProblem.parse(problem).errors).toHaveLength(1);
    expect(problem.status).toBe(422);
  });

  it('never exposes detail or extensions of a server error', () => {
    const problem = toProblem(
      new InternalServerError({
        detail: 'connect ECONNREFUSED 10.0.0.5:5432',
        extensions: { sql: 'x' },
      }),
    );

    expect(problem).toEqual({
      type: 'https://api.ticketnest.example/problems/internal-error',
      title: 'Internal server error',
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('does not let extensions overwrite core members', () => {
    const problem = toProblem(new ConflictError({ extensions: { status: 200, title: 'ok' } }));

    expect(problem.status).toBe(409);
    expect(problem.title).toBe('Conflict');
  });
});
