import { generateCorrelationId, REQUEST_ID_HEADER, runWithCorrelationId } from '@ticketnest/logger';
import { type RequestHandler } from 'express';

const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

function findRequestId(candidate: string | undefined): string {
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate)
    ? candidate
    : generateCorrelationId();
}

/**
 * Uses the caller's `X-Request-Id` when it is safe, otherwise generates one, echoes it on the
 * response and runs the rest of the request inside the correlation context.
 */
export const handleRequestId: RequestHandler = (request, response, next) => {
  const requestId = findRequestId(request.get(REQUEST_ID_HEADER));
  response.set('X-Request-Id', requestId);
  runWithCorrelationId(requestId, next);
};
