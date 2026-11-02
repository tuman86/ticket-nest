/** Base of every problem `type` URI (see docs/api/common.yaml). */
export const PROBLEM_TYPE_BASE_URL = 'https://api.ticketnest.example/problems/';

export const PROBLEM_TYPE_SLUGS = {
  malformedRequest: 'malformed-request',
  requestRejected: 'request-rejected',
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  notFound: 'not-found',
  conflict: 'conflict',
  validationError: 'validation-error',
  internalError: 'internal-error',
} as const;
