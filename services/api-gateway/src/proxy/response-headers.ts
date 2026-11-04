import { type IncomingHttpHeaders } from 'node:http';

/**
 * Headers that describe one connection, not the response, or that the gateway owns:
 * hop-by-hop headers (RFC 9110 section 7.6.1), the framework fingerprint, and the request id the
 * gateway already set.
 */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'server',
  'x-powered-by',
  'x-request-id',
]);

/** CORS is decided by the gateway alone, so a service cannot widen it. */
const DROPPED_RESPONSE_HEADER_PREFIX = 'access-control-';

/**
 * Keeps the headers of a service's response that are safe and useful to pass to the client.
 *
 * @param headers - The response headers from the service.
 * @returns The headers to set on the gateway's response.
 */
export function filterUpstreamResponseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const isDropped =
      DROPPED_RESPONSE_HEADERS.has(name) || name.startsWith(DROPPED_RESPONSE_HEADER_PREFIX);
    if (!isDropped && value !== undefined) {
      kept[name] = value;
    }
  }
  return kept;
}
