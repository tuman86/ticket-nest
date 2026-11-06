/** Base of every problem `type` URI (see docs/api/common.yaml). */
export const PROBLEM_TYPE_BASE_URL = 'https://api.ticketnest.example/problems/';

export const PROBLEM_TYPE_SLUGS = {
  malformedRequest: 'malformed-request',
  requestRejected: 'request-rejected',
  unauthenticated: 'unauthenticated',
  reauthenticationRequired: 'reauthentication-required',
  forbidden: 'forbidden',
  notFound: 'not-found',
  methodNotAllowed: 'method-not-allowed',
  conflict: 'conflict',
  validationError: 'validation-error',
  rateLimited: 'rate-limited',
  unavailable: 'unavailable',
  badGateway: 'bad-gateway',
  gatewayTimeout: 'gateway-timeout',
  internalError: 'internal-error',
} as const;
