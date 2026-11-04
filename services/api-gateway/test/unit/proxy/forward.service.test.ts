import { Readable } from 'node:stream';

import { BadGatewayError, GatewayTimeoutError, ServiceUnavailableError } from '@ticketnest/errors';
import { beforeEach, describe, expect, it } from 'vitest';

import { CircuitBreaker } from '@/proxy/circuit-breaker';
import { ForwardService, type ForwardRequest } from '@/proxy/forward.service';

import { createTestApp } from '../../support/create-test-app';
import { FakeUpstreamClient } from '../../support/fake-upstream-client';

const THRESHOLD = 2;
const SLEEPS: number[] = [];

let upstream: FakeUpstreamClient;
let service: ForwardService;

/**
 * @param overrides - Fields of the request to change.
 * @returns A forward request for a GET with a small body stream the service must ignore.
 */
function createRequest(overrides: Partial<ForwardRequest> = {}): ForwardRequest {
  return {
    upstream: 'catalog',
    method: 'GET',
    pathAndQuery: '/v1/search',
    headers: {},
    body: Readable.from([]),
    clientIp: '203.0.113.7',
    protocol: 'https',
    requestId: 'req-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  SLEEPS.length = 0;
  upstream = new FakeUpstreamClient();
  const { logger } = createTestApp();
  const createBreaker = () => new CircuitBreaker({ failureThreshold: THRESHOLD, openMs: 10_000 });
  service = new ForwardService({
    upstreamClient: upstream,
    circuitBreakers: { auth: createBreaker(), catalog: createBreaker() },
    maxRequestBodyBytes: 1_024,
    logger,
    sleep: (milliseconds) => {
      SLEEPS.push(milliseconds);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
});

describe('ForwardService retries', () => {
  it('tries a GET again, once, after a pause with jitter, when the service is unreachable', async () => {
    upstream.enqueue(new BadGatewayError(), { status: 200 });

    const response = await service.forward(createRequest());

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(SLEEPS).toEqual([50 + 0.5 * 100]);
  });

  it('gives up after the second attempt', async () => {
    upstream.alwaysRespond(new BadGatewayError());

    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(BadGatewayError);
    expect(upstream.requests).toHaveLength(2);
  });

  it('does not retry a timeout, which would double the wait', async () => {
    upstream.enqueue(new GatewayTimeoutError(), { status: 200 });

    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);
    expect(upstream.requests).toHaveLength(1);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('never retries a %s', async (method) => {
    upstream.alwaysRespond(new BadGatewayError());

    await expect(service.forward(createRequest({ method }))).rejects.toBeInstanceOf(
      BadGatewayError,
    );
    expect(upstream.requests).toHaveLength(1);
  });

  it('does not retry an answer, even a 503, because the service did respond', async () => {
    upstream.enqueue({ status: 503 }, { status: 200 });

    const response = await service.forward(createRequest());

    expect(response.status).toBe(503);
    expect(upstream.requests).toHaveLength(1);
  });
});

describe('ForwardService circuit breaker', () => {
  it('opens after repeated failures and then refuses without calling the service', async () => {
    upstream.alwaysRespond(new GatewayTimeoutError());

    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);
    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);
    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(ServiceUnavailableError);

    expect(upstream.requests).toHaveLength(THRESHOLD);
  });

  it.each([502, 503, 504])('counts a %i answer as the service being down', async (status) => {
    upstream.alwaysRespond({ status });

    await service.forward(createRequest());
    await service.forward(createRequest());

    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('does not count a 500, which is one endpoint failing and not the service being down', async () => {
    upstream.alwaysRespond({ status: 500 });

    for (let attempt = 0; attempt < THRESHOLD + 2; attempt += 1) {
      await service.forward(createRequest());
    }

    expect(upstream.requests).toHaveLength(THRESHOLD + 2);
  });

  it('keeps one breaker per service, so a failing catalog does not block auth', async () => {
    upstream.enqueue(new GatewayTimeoutError(), new GatewayTimeoutError());
    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);
    await expect(service.forward(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);

    const response = await service.forward(createRequest({ upstream: 'auth' }));

    expect(response.status).toBe(200);
  });

  it('does not count a refused oversized body against the service', async () => {
    for (let attempt = 0; attempt < THRESHOLD + 1; attempt += 1) {
      await expect(
        service.forward(
          createRequest({
            method: 'POST',
            body: Readable.from([Buffer.alloc(2_048)]),
          }),
        ),
      ).rejects.toMatchObject({ status: 413 });
    }

    await expect(service.forward(createRequest({ method: 'POST' }))).resolves.toBeDefined();
  });
});

describe('ForwardService request building', () => {
  it('sends no body for a GET even if the client sent one', async () => {
    await service.forward(createRequest({ body: Readable.from([Buffer.from('sneaky')]) }));

    expect(upstream.requests[0]?.bodyText).toBeNull();
  });

  it('streams the body of a POST through', async () => {
    await service.forward(
      createRequest({
        method: 'POST',
        body: Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]),
      }),
    );

    expect(upstream.requests[0]?.bodyText).toBe('{"a":1}');
  });

  it('refuses a chunked body that grows past the limit', async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600)];

    await expect(
      service.forward(createRequest({ method: 'POST', body: Readable.from(chunks) })),
    ).rejects.toMatchObject({ status: 413, code: 'REQUEST_REJECTED' });
  });

  it('filters the headers of the answer', async () => {
    upstream.enqueue({
      headers: { etag: '"v2"', 'x-powered-by': 'Express', connection: 'keep-alive' },
    });

    const response = await service.forward(createRequest());

    expect(response.headers).toEqual({ etag: '"v2"' });
  });

  it('forces Cache-Control: no-store on every answer of auth-service, whatever it sent', async () => {
    upstream.enqueue(
      { headers: { 'cache-control': 'public, max-age=600' } },
      { headers: { etag: '"v1"' } },
    );

    const first = await service.forward(createRequest({ upstream: 'auth' }));
    const second = await service.forward(createRequest({ upstream: 'auth' }));

    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.headers.etag).toBe('"v1"');
  });

  it('leaves the caching headers of catalog-service alone', async () => {
    upstream.enqueue({ headers: { 'cache-control': 'public, max-age=60' } });

    const response = await service.forward(createRequest({ upstream: 'catalog' }));

    expect(response.headers['cache-control']).toBe('public, max-age=60');
  });
});
