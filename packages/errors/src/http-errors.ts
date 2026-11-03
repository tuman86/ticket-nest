import { type FieldError } from '@ticketnest/contracts';

import { AppError, type AppErrorDefinition, type AppErrorOptions } from './app-error';
import { PROBLEM_TYPE_SLUGS } from './problem-types';

const BAD_REQUEST: AppErrorDefinition = {
  status: 400,
  code: 'MALFORMED_REQUEST',
  title: 'Malformed request',
  problemType: PROBLEM_TYPE_SLUGS.malformedRequest,
};

const UNAUTHORIZED: AppErrorDefinition = {
  status: 401,
  code: 'UNAUTHENTICATED',
  title: 'Authentication required',
  problemType: PROBLEM_TYPE_SLUGS.unauthenticated,
  headers: { 'WWW-Authenticate': 'Bearer' },
};

const FORBIDDEN: AppErrorDefinition = {
  status: 403,
  code: 'FORBIDDEN',
  title: 'Forbidden',
  problemType: PROBLEM_TYPE_SLUGS.forbidden,
};

const NOT_FOUND: AppErrorDefinition = {
  status: 404,
  code: 'NOT_FOUND',
  title: 'Resource not found',
  problemType: PROBLEM_TYPE_SLUGS.notFound,
};

const METHOD_NOT_ALLOWED: AppErrorDefinition = {
  status: 405,
  code: 'METHOD_NOT_ALLOWED',
  title: 'Method not allowed',
  problemType: PROBLEM_TYPE_SLUGS.methodNotAllowed,
};

const CONFLICT: AppErrorDefinition = {
  status: 409,
  code: 'CONFLICT',
  title: 'Conflict',
  problemType: PROBLEM_TYPE_SLUGS.conflict,
};

const VALIDATION_ERROR: AppErrorDefinition = {
  status: 422,
  code: 'VALIDATION_ERROR',
  title: 'Validation failed',
  problemType: PROBLEM_TYPE_SLUGS.validationError,
};

const INTERNAL_SERVER_ERROR: AppErrorDefinition = {
  status: 500,
  code: 'INTERNAL_ERROR',
  title: 'Internal server error',
  problemType: PROBLEM_TYPE_SLUGS.internalError,
};

const DEFAULT_VALIDATION_DETAIL = 'One or more fields are invalid.';

/** 400: the request could not be parsed (bad JSON, wrong parameter type). */
export class BadRequestError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(BAD_REQUEST, options);
  }
}

/** 401: missing, expired or invalid credentials. Sends a `Bearer` challenge. */
export class UnauthorizedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(UNAUTHORIZED, options);
  }
}

/** 403: authenticated, but not allowed. */
export class ForbiddenError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(FORBIDDEN, options);
  }
}

/** 404: also used for other tenants' resources (never 403). */
export class NotFoundError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(NOT_FOUND, options);
  }
}

/** 405: the path exists but not for this HTTP method. Sends an `Allow` header (RFC 9110). */
export class MethodNotAllowedError extends AppError {
  /**
   * @param allowedMethods - Methods the path accepts, such as `['GET', 'HEAD']`.
   * @param options - Optional detail, cause and extra headers.
   */
  constructor(allowedMethods: readonly string[], options: AppErrorOptions = {}) {
    super(METHOD_NOT_ALLOWED, {
      ...options,
      headers: { ...options.headers, Allow: allowedMethods.join(', ') },
    });
  }
}

/** 409: the request conflicts with current state, e.g. `SeatUnavailableError extends ConflictError`. */
export class ConflictError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(CONFLICT, options);
  }
}

/** 422: well-formed request whose fields fail validation. */
export class ValidationError extends AppError {
  readonly fieldErrors: readonly FieldError[];

  constructor(
    fieldErrors: readonly [FieldError, ...FieldError[]],
    options: Omit<AppErrorOptions, 'extensions'> = {},
  ) {
    super(VALIDATION_ERROR, {
      detail: DEFAULT_VALIDATION_DETAIL,
      ...options,
      extensions: { errors: fieldErrors },
    });
    this.fieldErrors = fieldErrors;
  }
}

/** 500: an unexpected failure. The response never carries its detail outside development. */
export class InternalServerError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(INTERNAL_SERVER_ERROR, options);
  }
}
