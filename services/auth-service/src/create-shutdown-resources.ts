import { type ShutdownResource } from '@ticketnest/service-runtime';

export interface ShutdownResourceSources {
  /**
   * What the outbox relay contributes, already in its own order: the relay, then the AMQP
   * connection. Empty when the relay is disabled.
   */
  readonly relayResources: readonly ShutdownResource[];
  /** Ends the Postgres pool. */
  readonly closePostgres: () => Promise<void>;
  /** Ends the Redis connection. */
  readonly closeRedis: () => Promise<void>;
}

/**
 * Orders what the service releases on shutdown, after the HTTP server has drained (ADR-0007,
 * "Readiness and shutdown"): the relay stops claiming and waits for its batch in flight, the AMQP
 * connection closes, and only then the Postgres pool and Redis. The relay reads from the pool, so
 * the pool must outlive it.
 *
 * @param sources - The relay's resources and the two closers for the pool and Redis.
 * @returns The resources, to close one after another in this order.
 */
export function createShutdownResources(
  sources: ShutdownResourceSources,
): readonly ShutdownResource[] {
  return [
    ...sources.relayResources,
    { name: 'postgres', close: sources.closePostgres },
    { name: 'redis', close: sources.closeRedis },
  ];
}
