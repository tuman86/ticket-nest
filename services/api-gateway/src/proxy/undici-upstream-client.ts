import { AppError, BadGatewayError, GatewayTimeoutError } from '@ticketnest/errors';
import { errors, Pool } from 'undici';

import { type UpstreamName } from '../routes/route-table';
import {
  UPSTREAM_BODY_TIMEOUT_MS,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UPSTREAM_HEADERS_TIMEOUT_MS,
  UPSTREAM_MAX_CONNECTIONS,
} from './proxy-constants';
import {
  type UpstreamClient,
  type UpstreamRequest,
  type UpstreamResponse,
} from './upstream-client';

export interface UndiciUpstreamClientOptions {
  /** Base origin of each service, such as `http://localhost:4001`. */
  readonly origins: Readonly<Record<UpstreamName, string>>;
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
}

/**
 * Turns a failure from undici into the gateway's own errors.
 *
 * @param error - What undici (or the request body stream) threw.
 * @returns The error to throw: a gateway error for a timeout or an unreachable service, or the
 *   original `AppError` when the request body stream failed on purpose (too large a body).
 */
function toGatewayError(error: unknown): Error {
  if (error instanceof AppError) {
    return error;
  }
  const isTimeout =
    error instanceof errors.HeadersTimeoutError ||
    error instanceof errors.BodyTimeoutError ||
    error instanceof errors.ConnectTimeoutError;
  return isTimeout
    ? new GatewayTimeoutError({ cause: error })
    : new BadGatewayError({ cause: error });
}

/**
 * Sends requests to the services over HTTP with undici, one connection pool per service. It does
 * not follow redirects and does not decompress, so the gateway passes bytes through untouched. The
 * only class that names undici; everything else depends on `UpstreamClient`.
 */
export class UndiciUpstreamClient implements UpstreamClient {
  private readonly pools: ReadonlyMap<UpstreamName, Pool>;

  /**
   * @param options - The origin of each service and optional timeouts (defaults in `proxy-constants.ts`).
   */
  constructor(options: UndiciUpstreamClientOptions) {
    const entries = Object.entries(options.origins) as [UpstreamName, string][];
    this.pools = new Map(
      entries.map(([name, origin]) => [
        name,
        new Pool(origin, {
          connections: UPSTREAM_MAX_CONNECTIONS,
          connect: { timeout: options.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS },
          headersTimeout: options.headersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS,
          bodyTimeout: options.bodyTimeoutMs ?? UPSTREAM_BODY_TIMEOUT_MS,
        }),
      ]),
    );
  }

  /**
   * Sends one request and resolves when the response headers arrive.
   *
   * @param request - The request to send.
   * @returns The service's response, with its body still streaming.
   * @throws GatewayTimeoutError when the connection, the first byte or the body stalls past its timeout.
   * @throws BadGatewayError when the service cannot be reached or breaks the protocol.
   */
  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const pool = this.pools.get(request.upstream);
    if (pool === undefined) {
      throw new BadGatewayError({ detail: `No origin is configured for ${request.upstream}.` });
    }
    try {
      const response = await pool.request({
        path: request.pathAndQuery,
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal: request.signal,
      });
      return { status: response.statusCode, headers: response.headers, body: response.body };
    } catch (error) {
      throw toGatewayError(error);
    }
  }

  /**
   * Closes every pool, letting running requests finish. Call it on shutdown.
   */
  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.close()));
  }
}
