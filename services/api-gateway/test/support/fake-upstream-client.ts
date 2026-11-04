import { type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';

import {
  type UpstreamClient,
  type UpstreamRequest,
  type UpstreamResponse,
} from '@/proxy/upstream-client';

/** What a service answers in a test. */
export interface FakeUpstreamAnswer {
  readonly status?: number;
  readonly headers?: IncomingHttpHeaders;
  /** Sent as the response body. Defaults to a small JSON document. */
  readonly body?: string;
}

/** One request as the fake service received it. */
export interface RecordedUpstreamRequest {
  readonly upstream: UpstreamRequest['upstream'];
  readonly method: UpstreamRequest['method'];
  readonly pathAndQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, read to the end. `null` when the gateway sent none. */
  readonly bodyText: string | null;
}

/** What a scripted step does: answer, or fail with an error such as `GatewayTimeoutError`. */
export type FakeUpstreamStep = FakeUpstreamAnswer | Error;

const DEFAULT_BODY = JSON.stringify({ ok: true });

/**
 * A stand-in for the services behind the gateway. It records every request it receives, reads
 * the request body, and answers from a script (or a default 200), so a test sees exactly what the
 * gateway sent and can make a service answer, fail or time out on demand.
 */
export class FakeUpstreamClient implements UpstreamClient {
  /** Every request received, oldest first. */
  readonly requests: RecordedUpstreamRequest[] = [];

  private readonly script: FakeUpstreamStep[] = [];
  private fallback: FakeUpstreamStep = {};

  /**
   * Queues answers for the next requests, in order. When the queue runs out the fallback applies.
   *
   * @param steps - Answers or errors, one per request.
   */
  enqueue(...steps: FakeUpstreamStep[]): void {
    this.script.push(...steps);
  }

  /**
   * Sets what every request gets once the queue is empty.
   *
   * @param step - An answer or an error.
   */
  alwaysRespond(step: FakeUpstreamStep): void {
    this.fallback = step;
  }

  /**
   * Records the request and plays the next step.
   *
   * @param request - The request the gateway sends.
   * @returns The scripted answer.
   * @throws Error when the step is an error.
   */
  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const bodyText = request.body === null ? null : await readAll(request.body);
    this.requests.push({
      upstream: request.upstream,
      method: request.method,
      pathAndQuery: request.pathAndQuery,
      headers: request.headers,
      bodyText,
    });
    const step = this.script.shift() ?? this.fallback;
    if (step instanceof Error) {
      throw step;
    }
    return {
      status: step.status ?? 200,
      headers: step.headers ?? { 'content-type': 'application/json' },
      body: Readable.from([Buffer.from(step.body ?? DEFAULT_BODY)]),
    };
  }
}

/**
 * @param stream - A readable stream.
 * @returns Everything it produced, as text.
 */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}
