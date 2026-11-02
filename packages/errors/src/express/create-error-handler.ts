import { type ErrorRequestHandler, type Request } from 'express';

import { type AppError } from '../app-error';
import { toProblem } from '../to-problem';
import { normalizeError } from './normalize-error';

const SERVER_ERROR_MIN_STATUS = 500;
const REQUEST_ID_HEADER = 'x-request-id';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const SAFE_CORRELATION_ID = /^[\w.-]{1,128}$/;

/** The slice of the shared logger the handler needs. The pino `Logger` satisfies it. */
export interface ErrorLogger {
  info: (fields: object, message: string) => void;
  error: (fields: object, message: string) => void;
}

export interface CreateErrorHandlerOptions {
  readonly logger: ErrorLogger;
  /** Normally `getCorrelationId` from `@ticketnest/logger`. */
  readonly getCorrelationId: () => string | undefined;
  /** Adds the message and stack to 500 responses. Pass `true` only in development. */
  readonly isDebugInfoExposed?: boolean;
}

function findInstance(request: Request): string {
  const queryStart = request.originalUrl.indexOf('?');
  return queryStart === -1 ? request.originalUrl : request.originalUrl.slice(0, queryStart);
}

function findCorrelationId(request: Request, known: string | undefined): string | undefined {
  const candidate = known ?? request.get(REQUEST_ID_HEADER);
  return candidate !== undefined && SAFE_CORRELATION_ID.test(candidate) ? candidate : undefined;
}

function addDebugInfo(problem: object, original: unknown): object {
  if (!(original instanceof Error)) {
    return problem;
  }
  return { ...problem, detail: original.message, stack: original.stack };
}

function logError(logger: ErrorLogger, appError: AppError, original: unknown): void {
  if (appError.status >= SERVER_ERROR_MIN_STATUS) {
    logger.error({ err: original, code: appError.code }, 'request failed');
    return;
  }
  logger.info({ status: appError.status, code: appError.code }, 'request rejected');
}

export function createErrorHandler(options: CreateErrorHandlerOptions): ErrorRequestHandler {
  const { logger, getCorrelationId, isDebugInfoExposed = false } = options;

  return (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const appError = normalizeError(error);
    const correlationId = findCorrelationId(request, getCorrelationId());
    const problem = toProblem(appError, {
      instance: findInstance(request),
      ...(correlationId === undefined ? {} : { correlationId }),
    });
    const isServerError = appError.status >= SERVER_ERROR_MIN_STATUS;

    logError(logger, appError, error);
    if (correlationId !== undefined) {
      response.set('X-Request-Id', correlationId);
    }
    response
      .status(appError.status)
      .set(appError.headers)
      .type(PROBLEM_CONTENT_TYPE)
      .json(isServerError && isDebugInfoExposed ? addDebugInfo(problem, error) : problem);
  };
}
