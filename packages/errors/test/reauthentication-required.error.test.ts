import { describe, expect, it } from 'vitest';

import { AppError } from '@/app-error';
import { UnauthorizedError } from '@/http-errors';
import { PROBLEM_TYPE_BASE_URL, PROBLEM_TYPE_SLUGS } from '@/problem-types';
import {
  REAUTHENTICATION_REQUIRED_DETAIL,
  ReauthenticationRequiredError,
} from '@/reauthentication-required.error';
import { toProblem } from '@/to-problem';

describe('ReauthenticationRequiredError', () => {
  it('is a 401 with its own code and problem type, as common.yaml documents', () => {
    const error = new ReauthenticationRequiredError();

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 401,
      code: 'REAUTHENTICATION_REQUIRED',
      title: 'Recent login required',
      problemType: 'reauthentication-required',
    });
  });

  it('registers its problem type slug with the others', () => {
    expect(PROBLEM_TYPE_SLUGS.reauthenticationRequired).toBe('reauthentication-required');
  });

  it('sends the Bearer challenge like every 401', () => {
    expect(new ReauthenticationRequiredError().headers).toEqual({
      'WWW-Authenticate': 'Bearer',
    });
  });

  it('always carries the fixed detail', () => {
    const error = new ReauthenticationRequiredError();

    expect(REAUTHENTICATION_REQUIRED_DETAIL).toBe(
      'This action needs a login within the last 5 minutes.',
    );
    expect(error.detail).toBe(REAUTHENTICATION_REQUIRED_DETAIL);
    expect(error.message).toBe(REAUTHENTICATION_REQUIRED_DETAIL);
  });

  it('names itself after its class', () => {
    expect(new ReauthenticationRequiredError().name).toBe('ReauthenticationRequiredError');
  });

  it('becomes the problem+json body the spec shows', () => {
    const problem = toProblem(new ReauthenticationRequiredError(), {
      instance: '/v1/roles',
      correlationId: 'correlation-1',
    });

    expect(problem).toEqual({
      type: `${PROBLEM_TYPE_BASE_URL}reauthentication-required`,
      title: 'Recent login required',
      status: 401,
      detail: REAUTHENTICATION_REQUIRED_DETAIL,
      code: 'REAUTHENTICATION_REQUIRED',
      instance: '/v1/roles',
      correlationId: 'correlation-1',
    });
  });

  it('keeps an optional cause for the log without putting it in the problem', () => {
    const cause = new Error('clock skew');
    const error = new ReauthenticationRequiredError({ cause });

    expect(error.cause).toBe(cause);
    expect(JSON.stringify(toProblem(error))).not.toContain('clock skew');
  });
});
