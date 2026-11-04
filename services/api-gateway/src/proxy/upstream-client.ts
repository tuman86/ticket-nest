import { type IncomingHttpHeaders } from 'node:http';
import { type Readable } from 'node:stream';

import { type UpstreamName } from '../routes/route-table';

/** The methods the gateway forwards. Anything else is refused before it reaches an upstream. */
export const FORWARDED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type ForwardedMethod = (typeof FORWARDED_METHODS)[number];

/** One request to a service, with its headers already filtered. */
export interface UpstreamRequest {
  readonly upstream: UpstreamName;
  readonly method: ForwardedMethod;
  /** Path and query string, starting with `/`. */
  readonly pathAndQuery: string;
  /** Lower-case header names. Only what the gateway chose to forward. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, streamed. `null` for a request that has none. */
  readonly body: Readable | null;
  /** Aborts the call when the client goes away. */
  readonly signal: AbortSignal;
}

/** A service's answer. The body is a stream, so large responses are never held in memory. */
export interface UpstreamResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
}

/**
 * Sends a request to one of the services behind the gateway. It is the only seam to the network,
 * so the forwarding rules can be tested with a fake and the HTTP library can be swapped.
 */
export interface UpstreamClient {
  /**
   * Sends the request and returns as soon as the response headers arrive.
   *
   * @param request - The request to send.
   * @returns The service's response, with its body still streaming.
   * @throws GatewayTimeoutError when the service does not answer in time.
   * @throws BadGatewayError when the service cannot be reached or breaks the protocol.
   */
  send(request: UpstreamRequest): Promise<UpstreamResponse>;
}
