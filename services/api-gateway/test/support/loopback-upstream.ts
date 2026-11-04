import { createServer, type RequestListener, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

const LOOPBACK = '127.0.0.1';

export interface LoopbackUpstream {
  /** Base origin of the server, such as `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Stops the server and drops open connections. */
  close(): Promise<void>;
}

/**
 * Starts a real HTTP server on a free loopback port, so the undici client is tested over a real
 * socket (no Docker, no external network).
 *
 * @param listener - What the server does with each request.
 * @returns The running server. Call `close` when the test is done.
 */
export async function startLoopbackUpstream(listener: RequestListener): Promise<LoopbackUpstream> {
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => {
    server.listen(0, LOOPBACK, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${LOOPBACK}:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * @returns An origin where nothing listens, so a connection is refused at once.
 */
export async function findClosedOrigin(): Promise<string> {
  const server = await startLoopbackUpstream(() => undefined);
  const { origin } = server;
  await server.close();
  return origin;
}
