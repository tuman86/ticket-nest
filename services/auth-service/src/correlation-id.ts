import { generateCorrelationId, getCorrelationId } from '@ticketnest/logger';

/**
 * Reads the correlation id of the request being handled, which `handleRequestId` has already
 * limited to 128 safe characters.
 *
 * @returns The current request's id, or a new one when no request context is active.
 */
export function readOrCreateCorrelationId(): string {
  return getCorrelationId() ?? generateCorrelationId();
}
