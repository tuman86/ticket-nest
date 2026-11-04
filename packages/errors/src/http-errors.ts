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

const TOO_MANY_REQUESTS: AppErrorDefinition = {
  status: 429,
  code: 'RATE_LIMITED',
  title: 'Too many requests',
  problemType: PROBLEM_TYPE_SLUGS.rateLimited,
};

const SERVICE_UNAVAILABLE: AppErrorDefinition = {
  status: 503,
  code: 'UNAVAILABLE',
  title: 'Service unavailable',
  problemType: PROBLEM_TYPE_SLUGS.unavailable,
};

const BAD_GATEWAY: AppErrorDefinition = {
  status: 502,
  code: 'BAD_GATEWAY',
  title: 'Bad gateway',
  problemType: PROBLEM_TYPE_SLUGS.badGateway,
};

const GATEWAY_TIMEOUT: AppErrorDefinition = {
  status: 504,
  code: 'GATEWAY_TIMEOUT',
  title: 'Gateway timeout',
  problemType: PROBLEM_TYPE_SLUGS.gatewayTimeout,
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

/** What a client needs to know about the limit it hit. */
export interface RateLimitExceeded {
  /** Requests allowed in the window that was exceeded. */
  readonly limit: number;
  /** Whole seconds until the window resets, at least 1. */
  readonly retryAfterSeconds: number;
}

/** 429: a rate limit was exceeded. Sends `Retry-After` and the `RateLimit-*` headers (common.yaml). */
export class TooManyRequestsError extends AppError {
  /**
   * Builds a 429 whose headers tell the client when to retry.
   *
   * @param rateLimit - The limit that was hit and how long until it resets.
   * @param options - Optional code, cause and extra headers. `detail` defaults to a retry hint.
   */
  constructor(rateLimit: RateLimitExceeded, options: AppErrorOptions = {}) {
    const retryAfter = String(rateLimit.retryAfterSeconds);
    super(TOO_MANY_REQUESTS, {
      detail: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      ...options,
      headers: {
        'Retry-After': retryAfter,
        'RateLimit-Limit': String(rateLimit.limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': retryAfter,
        ...options.headers,
      },
    });
  }
}

/** Options of `ServiceUnavailableError`. */
export interface ServiceUnavailableOptions extends AppErrorOptions {
  /** Whole seconds the client should wait before retrying. */
  readonly retryAfterSeconds: number;
}

/**
 * 503: a dependency is down and the request was refused on purpose. Sends `Retry-After`.
 * The response never carries `detail`, like every server error.
 */
export class ServiceUnavailableError extends AppError {
  /**
   * Builds a 503 that tells the client when to retry.
   *
   * @param options - The retry delay, plus optional code, cause and extra headers.
   */
  constructor(options: ServiceUnavailableOptions) {
    const { retryAfterSeconds, ...rest } = options;
    super(SERVICE_UNAVAILABLE, {
      ...rest,
      headers: { 'Retry-After': String(retryAfterSeconds), ...rest.headers },
    });
  }
}

/**
 * 502: an upstream service could not be reached or answered with something unusable. Raised by the
 * gateway. The response never carries `detail`, because the cause names an internal host.
 */
export class BadGatewayError extends AppError {
  /**
   * @param options - Optional code and cause. The cause is kept for the log only.
   */
  constructor(options: AppErrorOptions = {}) {
    super(BAD_GATEWAY, options);
  }
}

/**
 * 504: an upstream service did not answer in time. Raised by the gateway. The response never
 * carries `detail`.
 */
export class GatewayTimeoutError extends AppError {
  /**
   * @param options - Optional code and cause. The cause is kept for the log only.
   */
  constructor(options: AppErrorOptions = {}) {
    super(GATEWAY_TIMEOUT, options);
  }
}
