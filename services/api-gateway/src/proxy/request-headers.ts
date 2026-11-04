import { type IncomingHttpHeaders } from 'node:http';

import { isKnownClientIp } from '@ticketnest/rate-limit';

/**
 * The only headers copied from the client's request. A header not listed here, such as `Cookie`
 * or a spoofed `X-User-Id`, never reaches a service. `Authorization` crosses unchanged, because
 * every service verifies the token itself (ADR-0013). `Content-Length` is technical: the body is
 * streamed, so its length must match what the service is told.
 */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'content-length',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'user-agent',
] as const;

export interface UpstreamRequestHeaderInput {
  /** The client's request headers. */
  readonly incoming: IncomingHttpHeaders;
  /** The client address Express settled on (`request.ip`), already validated. */
  readonly clientIp: string;
  /** `http` or `https`, as Express settled on it. */
  readonly protocol: string;
  readonly requestId: string | undefined;
}

/**
 * Builds the headers sent to a service: the allowlisted ones from the client, plus the ones the
 * gateway sets itself. `X-Forwarded-For` is overwritten with the single address the gateway
 * resolved, never copied from the client, so every service can keep `TRUST_PROXY_HOPS=1`
 * whatever sits in front of the gateway.
 *
 * @param input - The client's headers and what the gateway knows about the request.
 * @returns Lower-case header names with string values.
 */
export function buildUpstreamRequestHeaders(
  input: UpstreamRequestHeaderInput,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = input.incoming[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  if (isKnownClientIp(input.clientIp)) {
    headers['x-forwarded-for'] = input.clientIp;
  }
  headers['x-forwarded-proto'] = input.protocol;
  if (input.requestId !== undefined) {
    headers['x-request-id'] = input.requestId;
  }
  return headers;
}
