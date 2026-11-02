import { createLogger } from '@ticketnest/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ClosableServer, createShutdown, type ShutdownResource } from './shutdown';

const TIMEOUT_MS = 5_000;

afterEach(() => {
  vi.useRealTimers();
});

function createFakeServer(isStuck = false) {
  const calls: string[] = [];
  const server: ClosableServer = {
    close: (callback) => {
      calls.push('server.close');
      if (!isStuck) {
        setImmediate(() => {
          callback();
        });
      }
    },
    closeIdleConnections: () => {
      calls.push('server.closeIdleConnections');
    },
    closeAllConnections: () => {
      calls.push('server.closeAllConnections');
    },
  };
  return { server, calls };
}

function createResource(name: string, calls: string[], error?: Error): ShutdownResource {
  return {
    name,
    close: () => {
      calls.push(`${name}.close`);
      return error === undefined ? Promise.resolve() : Promise.reject(error);
    },
  };
}

function build(resources: (calls: string[]) => ShutdownResource[], isStuck = false) {
  const { server, calls } = createFakeServer(isStuck);
  const exit = vi.fn();
  const shutdown = createShutdown({
    resources: resources(calls),
    timeoutMs: TIMEOUT_MS,
    logger: createLogger({ serviceName: 'test', level: 'silent', nodeEnvironment: 'test' }),
    exit,
  });
  return { ...shutdown, server, calls, exit };
}

describe('createShutdown', () => {
  it('drains the server first, then closes resources in order, and exits 0', async () => {
    const { shutdown, server, calls, exit } = build((recorded) => [
      createResource('postgres', recorded),
      createResource('redis', recorded),
    ]);

    await shutdown('SIGTERM', server);

    expect(calls).toEqual([
      'server.close',
      'server.closeIdleConnections',
      'postgres.close',
      'redis.close',
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('reports not shutting down until it starts', async () => {
    const { shutdown, isShuttingDown, server } = build(() => []);

    expect(isShuttingDown()).toBe(false);
    const finished = shutdown('SIGTERM', server);
    expect(isShuttingDown()).toBe(true);
    await finished;
  });

  it('still closes the other resources when one fails, and exits 1', async () => {
    const { shutdown, server, calls, exit } = build((recorded) => [
      createResource('postgres', recorded, new Error('pool already ended')),
      createResource('redis', recorded),
    ]);

    await shutdown('SIGTERM', server);

    expect(calls).toContain('redis.close');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('runs once when signalled twice', async () => {
    const { shutdown, server, calls, exit } = build((recorded) => [
      createResource('postgres', recorded),
    ]);

    await Promise.all([shutdown('SIGTERM', server), shutdown('SIGINT', server)]);

    expect(calls.filter((call) => call === 'server.close')).toHaveLength(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('cuts remaining connections and exits 1 when draining takes too long', async () => {
    vi.useFakeTimers();
    const { shutdown, server, calls, exit } = build(() => [], true);

    void shutdown('SIGTERM', server);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(calls).toContain('server.closeAllConnections');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
