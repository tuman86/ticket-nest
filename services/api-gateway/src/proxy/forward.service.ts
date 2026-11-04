import { type IncomingHttpHeaders } from 'node:http';
import { type Readable } from 'node:stream';
import { setTimeout as sleepFor } from 'node:timers/promises';

import { BadGatewayError, GatewayTimeoutError } from '@ticketnest/errors';
import { type Logger } from '@ticketnest/logger';

import { type UpstreamName } from '../routes/route-table';
import { type CircuitBreaker } from './circuit-breaker';
import { limitBodySize } from './limit-body-size';
import {
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
  RETRY_MAX_ATTEMPTS,
  SINGLE_ATTEMPT,
  UPSTREAM_DOWN_STATUSES,
} from './proxy-constants';
import { buildUpstreamRequestHeaders } from './request-headers';
import { filterUpstreamResponseHeaders } from './response-headers';
import {
  type ForwardedMethod,
  type UpstreamClient,
  type UpstreamRequest,
  type UpstreamResponse,
} from './upstream-client';

const CACHE_CONTROL = 'cache-control';
const NO_STORE = 'no-store';

/** Methods without a request body, which are also safe to repeat. */
const SAFE_METHODS: ReadonlySet<ForwardedMethod> = new Set(['GET', 'HEAD']);

/** What the forward service needs to know about a client request. */
export interface ForwardRequest {
  readonly upstream: UpstreamName;
  readonly method: ForwardedMethod;
  /** Path and query string, starting with `/`. */
  readonly pathAndQuery: string;
  /** The client's request headers. */
  readonly headers: IncomingHttpHeaders;
  /** The client's request body. Only read for methods that carry one. */
  readonly body: Readable;
  /** The client address Express settled on, validated. */
  readonly clientIp: string;
  readonly protocol: string;
  readonly requestId: string | undefined;
  readonly signal: AbortSignal;
}

/** What goes back to the client: the service's status, filtered headers and streaming body. */
export interface ForwardResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[]>>;
  readonly body: Readable;
}

export interface ForwardServiceOptions {
  readonly upstreamClient: UpstreamClient;
  /** One breaker per service, so one failing service does not block the others. */
  readonly circuitBreakers: Readonly<Record<UpstreamName, CircuitBreaker>>;
  /** Largest request body forwarded, in bytes. */
  readonly maxRequestBodyBytes: number;
  readonly logger: Logger;
  /** Pause between attempts, replaceable in tests. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Random number in [0, 1) for retry jitter, replaceable in tests. */
  readonly random?: () => number;
}

/**
 * Forwards a client request to the service that owns it: filters what is sent, guards the call
 * with a circuit breaker, retries a safe request once when the service is unreachable, and
 * filters what comes back. It holds the rules; the network is behind `UpstreamClient`.
 */
export class ForwardService {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  /**
   * @param options - The client, the breakers, the body limit, a logger and optional test hooks.
   */
  constructor(private readonly options: ForwardServiceOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => sleepFor(milliseconds));
    this.random = options.random ?? Math.random;
  }

  /**
   * Sends the request to its service and returns the answer. Side effects: the request body is
   * consumed, and the service's circuit breaker records the outcome.
   *
   * @param request - The client request and what the gateway knows about it.
   * @returns The service's status, the headers that may pass (auth-service answers always carry
   *   `Cache-Control: no-store`), and the body as a stream.
   * @throws ServiceUnavailableError when the service's circuit is open.
   * @throws GatewayTimeoutError when the service does not answer in time.
   * @throws BadGatewayError when the service cannot be reached.
   * @throws RequestRejectedError (413) when the request body is over the limit.
   */
  async forward(request: ForwardRequest): Promise<ForwardResponse> {
    const upstreamRequest: UpstreamRequest = {
      upstream: request.upstream,
      method: request.method,
      pathAndQuery: request.pathAndQuery,
      headers: buildUpstreamRequestHeaders({
        incoming: request.headers,
        clientIp: request.clientIp,
        protocol: request.protocol,
        requestId: request.requestId,
      }),
      body: SAFE_METHODS.has(request.method)
        ? null
        : limitBodySize(request.body, this.options.maxRequestBodyBytes),
      signal: request.signal,
    };
    const response = await this.sendWithRetry(upstreamRequest);
    const headers = filterUpstreamResponseHeaders(response.headers);
    return {
      status: response.status,
      // Answers of auth-service can carry tokens, which must never be cached (security.md).
      // The gateway guarantees it instead of trusting every route of the service to set it.
      headers: request.upstream === 'auth' ? { ...headers, [CACHE_CONTROL]: NO_STORE } : headers,
      body: response.body,
    };
  }

  /**
   * Sends the request, trying a safe method again when the service is unreachable. A timeout is
   * not retried, since it would double the wait, and a request with a body is never retried.
   *
   * @param upstreamRequest - The request to send.
   * @returns The service's response.
   * @throws ServiceUnavailableError when the service's circuit is open.
   * @throws GatewayTimeoutError when the service does not answer in time.
   * @throws BadGatewayError when the service stays unreachable after the last attempt.
   */
  private async sendWithRetry(upstreamRequest: UpstreamRequest): Promise<UpstreamResponse> {
    const maxAttempts = SAFE_METHODS.has(upstreamRequest.method)
      ? RETRY_MAX_ATTEMPTS
      : SINGLE_ATTEMPT;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendOnce(upstreamRequest);
      } catch (error) {
        if (!(error instanceof BadGatewayError) || attempt >= maxAttempts) {
          throw error;
        }
        this.options.logger.warn({ upstream: upstreamRequest.upstream, attempt }, 'retrying');
        await this.sleep(RETRY_BASE_DELAY_MS + this.random() * RETRY_JITTER_MS);
      }
    }
  }

  /**
   * Makes one attempt through the service's circuit breaker and records how it went. Side effect:
   * the breaker learns the outcome, so a trial request always settles the circuit.
   *
   * @param upstreamRequest - The request to send.
   * @returns The service's response, whatever its status.
   * @throws ServiceUnavailableError when the service's circuit is open.
   * @throws GatewayTimeoutError when the service does not answer in time.
   * @throws BadGatewayError when the service cannot be reached.
   */
  private async sendOnce(upstreamRequest: UpstreamRequest): Promise<UpstreamResponse> {
    const breaker = this.options.circuitBreakers[upstreamRequest.upstream];
    breaker.beforeRequest();
    try {
      const response = await this.options.upstreamClient.send(upstreamRequest);
      if (UPSTREAM_DOWN_STATUSES.has(response.status)) {
        breaker.recordFailure();
      } else {
        breaker.recordSuccess();
      }
      return response;
    } catch (error) {
      if (error instanceof BadGatewayError || error instanceof GatewayTimeoutError) {
        breaker.recordFailure();
      } else {
        breaker.recordNeutral();
      }
      throw error;
    }
  }
}
