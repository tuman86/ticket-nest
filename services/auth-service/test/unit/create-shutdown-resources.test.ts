import { createLogger } from '@ticketnest/logger';
import {
  type ClosableServer,
  createShutdown,
  type ShutdownResource,
} from '@ticketnest/service-runtime';
import { describe, expect, it, vi } from 'vitest';

import { createShutdownResources } from '@/create-shutdown-resources';

const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;

const logger = createLogger({
  serviceName: 'auth-service',
  level: 'silent',
  nodeEnvironment: 'test',
});

/**
 * @param calls - Receives one entry per call, in call order.
 * @returns A server that drains on the next tick.
 */
function createFakeServer(calls: string[]): ClosableServer {
  return {
    close: (callback) => {
      calls.push('server.close');
      setImmediate(() => {
        callback();
      });
    },
    closeIdleConnections: () => undefined,
    closeAllConnections: () => undefined,
  };
}

/**
 * @param name - The resource name, which the call log uses.
 * @param calls - Receives `<name>.close` when the resource is closed.
 * @param error - Makes the close fail.
 * @returns A resource that records its close.
 */
function createRecordingResource(name: string, calls: string[], error?: Error): ShutdownResource {
  return {
    name,
    close: () => {
      calls.push(`${name}.close`);
      return error === undefined ? Promise.resolve() : Promise.reject(error);
    },
  };
}

/**
 * Runs the real `createShutdown` over the resources the service builds, the way `server.ts` does.
 *
 * @param relayResources - What the relay contributes: the relay then the AMQP connection, or nothing.
 * @param calls - The shared call log.
 * @returns The exit function, which the shutdown calls once with the exit code.
 */
async function runShutdown(
  relayResources: readonly ShutdownResource[],
  calls: string[],
): Promise<ReturnType<typeof vi.fn>> {
  const exit = vi.fn();
  const { shutdown } = createShutdown({
    resources: createShutdownResources({
      relayResources,
      closePostgres: () => createRecordingResource('postgres', calls).close(),
      closeRedis: () => createRecordingResource('redis', calls).close(),
    }),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger,
    exit,
  });
  await shutdown('SIGTERM', createFakeServer(calls));
  return exit;
}

describe('createShutdownResources', () => {
  it('drains the server, then closes the relay, the AMQP connection, Postgres and Redis in that order', async () => {
    const calls: string[] = [];

    const exit = await runShutdown(
      [createRecordingResource('outbox-relay', calls), createRecordingResource('amqp', calls)],
      calls,
    );

    expect(calls).toEqual([
      'server.close',
      'outbox-relay.close',
      'amqp.close',
      'postgres.close',
      'redis.close',
    ]);
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
  });

  it('closes only Postgres, then Redis, when the relay contributes no resources', async () => {
    const calls: string[] = [];

    await runShutdown([], calls);

    expect(calls).toEqual(['server.close', 'postgres.close', 'redis.close']);
  });

  it('continues with the AMQP connection, Postgres and Redis when the relay fails to stop, and exits with 1', async () => {
    const calls: string[] = [];

    const exit = await runShutdown(
      [
        createRecordingResource('outbox-relay', calls, new Error('stop failed')),
        createRecordingResource('amqp', calls),
      ],
      calls,
    );

    expect(calls).toEqual([
      'server.close',
      'outbox-relay.close',
      'amqp.close',
      'postgres.close',
      'redis.close',
    ]);
    expect(exit).toHaveBeenCalledWith(EXIT_FAILED);
  });

  it('names the resources outbox-relay, amqp, postgres and redis', () => {
    const resources = createShutdownResources({
      relayResources: [
        createRecordingResource('outbox-relay', []),
        createRecordingResource('amqp', []),
      ],
      closePostgres: () => Promise.resolve(),
      closeRedis: () => Promise.resolve(),
    });

    expect(resources.map((resource) => resource.name)).toEqual([
      'outbox-relay',
      'amqp',
      'postgres',
      'redis',
    ]);
  });
});
