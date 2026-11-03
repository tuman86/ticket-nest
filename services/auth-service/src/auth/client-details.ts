import { type Request } from 'express';

import { IP_MAX_LENGTH, USER_AGENT_MAX_LENGTH } from './token-constants';

/** What a session records about the client that opened it. */
export interface ClientDetails {
  /** `User-Agent`, cut to fit its column, or null when absent. */
  readonly userAgent: string | null;
  /** Client IP, cut to fit its column, or null when unknown. */
  readonly ip: string | null;
}

/**
 * @param value - A client-supplied string, or undefined when absent.
 * @param maxLength - The longest value the database column holds.
 * @returns The value cut to `maxLength`, or null when absent or empty.
 */
function truncateOrNull(value: string | undefined, maxLength: number): string | null {
  if (value === undefined || value === '') {
    return null;
  }
  return value.slice(0, maxLength);
}

/**
 * Reads the user agent and IP a new refresh token records. Both are untrusted input, so they are
 * truncated to the column sizes here.
 *
 * @param request - The incoming request.
 * @returns The details to store with the token.
 */
export function readClientDetails(request: Request): ClientDetails {
  return {
    userAgent: truncateOrNull(request.get('user-agent'), USER_AGENT_MAX_LENGTH),
    ip: truncateOrNull(request.ip, IP_MAX_LENGTH),
  };
}
