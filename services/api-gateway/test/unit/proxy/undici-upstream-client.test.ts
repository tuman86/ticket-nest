import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { BadGatewayError, GatewayTimeoutError } from '@ticketnest/errors';
import { afterEach, describe, expect, it } from 'vitest';

import { UndiciUpstreamClient } from '@/proxy/undici-upstream-client';
import { type UpstreamRequest } from '@/proxy/upstream-client';

import {
  findClosedOrigin,
  startLoopbackUpstream,
  type LoopbackUpstream,
} from '../../support/loopback-upstream';

const clients: UndiciUpstreamClient[] = [];
const servers: LoopbackUpstream[] = [];

/**
 * @param listener - What the loopback service does with each request.
 * @param timeouts - Optional client timeouts.
 * @returns A client whose `auth` and `catalog` services are that loopback server.
 */
async function createClientFor(
  listener: Parameters<typeof startLoopbackUpstream>[0],
  timeouts: { headersTimeoutMs?: number } = {},
): Promise<UndiciUpstreamClient> {
  const server = await startLoopbackUpstream(listener);
  servers.push(server);
  const client = new UndiciUpstreamClient({
    origins: { auth: server.origin, catalog: server.origin },
    ...timeouts,
  });
  clients.push(client);
  return client;
}

/**
 * @param overrides - Fields to change.
 * @returns A GET to the auth service.
 */
function createRequest(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    upstream: 'auth',
    method: 'GET',
    pathAndQuery: '/v1/ping',
    headers: {},
    body: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('UndiciUpstreamClient', () => {
  it("returns the service's status, headers and streamed body", async () => {
    const client = await createClientFor((_request, response) => {
      response.writeHead(201, { 'x-custom': 'yes', 'content-type': 'text/plain' }).end('hello');
    });

    const response = await client.send(createRequest());

    expect(response.status).toBe(201);
    expect(response.headers['x-custom']).toBe('yes');
    await expect(text(response.body)).resolves.toBe('hello');
  });

  it('sends the method, the path with its query, the headers and the streamed body', async () => {
    let received = '';
    const client = await createClientFor((request, response) => {
      void text(request).then((body) => {
        received = JSON.stringify({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          forwardedFor: request.headers['x-forwarded-for'],
          body,
        });
        response.end();
      });
    });

    const response = await client.send(
      createRequest({
        method: 'POST',
        pathAndQuery: '/v1/auth/login?remember=1',
        headers: { authorization: 'Bearer t', 'x-forwarded-for': '203.0.113.7' },
        body: Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]),
      }),
    );
    await text(response.body);

    expect(JSON.parse(received)).toEqual({
      method: 'POST',
      url: '/v1/auth/login?remember=1',
      authorization: 'Bearer t',
      forwardedFor: '203.0.113.7',
      body: '{"a":1}',
    });
  });

  it('does not follow a redirect, so the client sees it', async () => {
    const client = await createClientFor((_request, response) => {
      response.writeHead(302, { location: 'http://elsewhere.invalid/' }).end();
    });

    const response = await client.send(createRequest());

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('http://elsewhere.invalid/');
    response.body.resume();
  });

  it('does not decompress, so the bytes pass through as the service sent them', async () => {
    const compressed = gzipSync('compressed body');
    const client = await createClientFor((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' }).end(compressed);
    });

    const response = await client.send(createRequest());
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    expect(response.headers['content-encoding']).toBe('gzip');
    expect(Buffer.concat(chunks).equals(compressed)).toBe(true);
  });

  it('throws a GatewayTimeoutError when the service does not start answering in time', async () => {
    const client = await createClientFor(() => undefined, { headersTimeoutMs: 50 });

    await expect(client.send(createRequest())).rejects.toBeInstanceOf(GatewayTimeoutError);
  });

  it('throws a BadGatewayError when nothing listens at the service', async () => {
    const origin = await findClosedOrigin();
    const client = new UndiciUpstreamClient({ origins: { auth: origin, catalog: origin } });
    clients.push(client);

    await expect(client.send(createRequest())).rejects.toBeInstanceOf(BadGatewayError);
  });

  it('stops waiting when the caller aborts', async () => {
    const client = await createClientFor(() => undefined);
    const controller = new AbortController();

    const pending = client.send(createRequest({ signal: controller.signal }));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  it('keeps the cause of a failure for the log, and puts no host in the message', async () => {
    const origin = await findClosedOrigin();
    const client = new UndiciUpstreamClient({ origins: { auth: origin, catalog: origin } });
    clients.push(client);

    const error = await client.send(createRequest()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayError);
    expect((error as BadGatewayError).cause).toBeDefined();
    expect((error as BadGatewayError).message).not.toContain('127.0.0.1');
  });
});
