import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { type KeyObject } from 'node:crypto';

const JWKS_PATH = '/.well-known/jwks.json';
const OK = 200;
const NOT_MODIFIED = 304;
const NOT_FOUND = 404;
const LOOPBACK = '127.0.0.1';

export interface PublishedKey {
  /** The `kid` the key is published under. */
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

export interface RecordedJwksRequest {
  /** The `If-None-Match` header the client sent, or `null`. */
  readonly ifNoneMatch: string | null;
}

/** A real HTTP server that behaves like auth-service's `/.well-known/jwks.json`. */
export interface FakeJwksServer {
  /** Full URL of the key set endpoint. */
  readonly url: string;
  /** Every request the endpoint received, oldest first. */
  readonly requests: readonly RecordedJwksRequest[];
  /** Replaces the published key set. The `ETag` changes with it. */
  publish(keys: readonly PublishedKey[]): void;
  /** Makes the endpoint answer with this status and a plain body until `recover` is called. */
  failWith(status: number): void;
  /** Makes the endpoint answer normally again. */
  recover(): void;
  /** Stops the server and drops open connections. */
  close(): Promise<void>;
}

/**
 * Starts a fake auth-service JWKS endpoint on a free loopback port. It serves the published keys
 * with a strong `ETag` and answers 304 to a matching `If-None-Match`, the way the real endpoint
 * does, so the fetcher, resolver and verifier are tested over real HTTP.
 *
 * @returns The running server. Call `close` when the test is done.
 */
export async function startFakeJwksServer(): Promise<FakeJwksServer> {
  const requests: RecordedJwksRequest[] = [];
  let keys: readonly PublishedKey[] = [];
  let version = 0;
  let failureStatus: number | null = null;

  const server = createServer((request, response) => {
    if (request.url !== JWKS_PATH) {
      response.writeHead(NOT_FOUND).end();
      return;
    }
    const ifNoneMatch = request.headers['if-none-match'] ?? null;
    requests.push({ ifNoneMatch });
    if (failureStatus !== null) {
      response.writeHead(failureStatus, { 'Content-Type': 'text/plain' }).end('unavailable');
      return;
    }
    const etag = `"v${String(version)}"`;
    if (ifNoneMatch === etag) {
      response.writeHead(NOT_MODIFIED, { ETag: etag }).end();
      return;
    }
    response
      .writeHead(OK, { 'Content-Type': 'application/jwk-set+json', ETag: etag })
      .end(JSON.stringify({ keys: keys.map(toPublishedJwk) }));
  });
  await listen(server);

  return {
    url: `http://${LOOPBACK}:${String((server.address() as AddressInfo).port)}${JWKS_PATH}`,
    requests,
    publish(newKeys) {
      keys = newKeys;
      version += 1;
    },
    failWith(status) {
      failureStatus = status;
    },
    recover() {
      failureStatus = null;
    },
    close: () => close(server),
  };
}

/**
 * @param key - A key to publish.
 * @returns The key as auth-service publishes it: Ed25519, `use: sig`, `alg: EdDSA`.
 */
function toPublishedJwk(key: PublishedKey): Record<string, string> {
  const { x } = key.publicKey.export({ format: 'jwk' });
  return { kty: 'OKP', crv: 'Ed25519', x: x ?? '', use: 'sig', alg: 'EdDSA', kid: key.keyId };
}

/**
 * @param server - A server that is not listening yet.
 * @returns A promise that settles once it listens on a free loopback port.
 */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolve);
  });
}

/**
 * @param server - A listening server.
 * @returns A promise that settles once the server and its keep-alive connections are closed.
 */
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections();
  });
}
