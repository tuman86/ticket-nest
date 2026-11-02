import { type Problem } from '@ticketnest/contracts';

import { type AppError } from './app-error';
import { PROBLEM_TYPE_BASE_URL } from './problem-types';

const SERVER_ERROR_MIN_STATUS = 500;

export interface ProblemContext {
  /** Request path without the query string (queries can carry tokens). */
  readonly instance?: string;
  readonly correlationId?: string;
}

/**
 * Builds the RFC 9457 body. Server errors (status 500+) never expose `detail` or extensions,
 * because their messages can name internals; client errors expose what the thrower chose.
 */
export function toProblem(error: AppError, context: ProblemContext = {}): Problem {
  const isServerError = error.status >= SERVER_ERROR_MIN_STATUS;

  return {
    ...(isServerError ? {} : error.extensions),
    type: `${PROBLEM_TYPE_BASE_URL}${error.problemType}`,
    title: error.title,
    status: error.status,
    ...(!isServerError && error.detail !== undefined ? { detail: error.detail } : {}),
    code: error.code,
    ...(context.instance === undefined ? {} : { instance: context.instance }),
    ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
  };
}
