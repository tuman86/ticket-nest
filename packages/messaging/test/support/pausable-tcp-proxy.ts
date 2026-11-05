import net from 'node:net';

/** What the proxy does with the bytes that pass through it. */
type ProxyMode = 'forward' | 'hold-to-broker' | 'blackhole';

/** Where the proxy sends the connections it accepts. */
export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

/** Bytes the proxy kept back from one connection, in arrival order. */
interface HeldChunk {
  readonly upstream: net.Socket;
  readonly chunk: Buffer;
}

/**
 * A TCP proxy for tests, between the code under test and the broker. It can keep the client's bytes
 * back from the broker (so a publish stays in flight while the broker still talks to the client),
 * or go silent in both directions without closing anything, which is what a half-open connection
 * looks like to the client.
 */
export class PausableTcpProxy {
  private mode: ProxyMode = 'forward';
  private readonly sockets = new Set<net.Socket>();
  private held: HeldChunk[] = [];

  private constructor(
    private readonly server: net.Server,
    private readonly target: ProxyTarget,
  ) {}

  /**
   * @param target - The broker's host and port.
   * @returns A proxy listening on a free local port.
   */
  static async start(target: ProxyTarget): Promise<PausableTcpProxy> {
    const server = net.createServer();
    const proxy = new PausableTcpProxy(server, target);
    server.on('connection', (client) => {
      proxy.handleConnection(client);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    return proxy;
  }

  /**
   * @returns The local port to connect to instead of the broker's.
   * @throws Error when the proxy is not listening on a TCP port.
   */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The proxy is not listening on a TCP port.');
    }
    return address.port;
  }

  /**
   * Keeps what the client sends back from the broker. Whatever the broker sends still reaches the
   * client.
   */
  holdTrafficToBroker(): void {
    this.mode = 'hold-to-broker';
  }

  /**
   * Stops forwarding in both directions and discards what arrives. The sockets stay open, so
   * neither side is told that the link is dead.
   */
  blackhole(): void {
    this.mode = 'blackhole';
    this.held = [];
  }

  /**
   * Forwards normally again, first sending the bytes that were held back.
   */
  forward(): void {
    this.mode = 'forward';
    const held = this.held;
    this.held = [];
    held.forEach(({ upstream, chunk }) => {
      if (!upstream.destroyed) {
        upstream.write(chunk);
      }
    });
  }

  /**
   * Closes the listener and every connection.
   */
  async stop(): Promise<void> {
    this.sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /**
   * @param client - A connection from the code under test.
   */
  private handleConnection(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    [client, upstream].forEach((socket) => {
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        this.sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    });
    client.on('data', (chunk: Buffer) => {
      this.relayToBroker(upstream, chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      this.relayToClient(client, chunk);
    });
  }

  /**
   * @param upstream - The connection to the broker.
   * @param chunk - Bytes the client sent.
   */
  private relayToBroker(upstream: net.Socket, chunk: Buffer): void {
    if (this.mode === 'blackhole') {
      return;
    }
    if (this.mode === 'hold-to-broker') {
      this.held.push({ upstream, chunk });
      return;
    }
    upstream.write(chunk);
  }

  /**
   * @param client - The connection to the code under test.
   * @param chunk - Bytes the broker sent.
   */
  private relayToClient(client: net.Socket, chunk: Buffer): void {
    if (this.mode !== 'blackhole') {
      client.write(chunk);
    }
  }
}
