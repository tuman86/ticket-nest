import {
  createPostgresCheck,
  type DependencyCheck,
  type Queryable,
} from '@ticketnest/service-runtime';

import { createRedisCheck, type Pingable } from './redis-check';

export interface ReadinessCheckSources {
  readonly pool: Queryable;
  readonly redis: Pingable;
}

/**
 * Builds the checks behind `/health/ready`: the service's own Postgres and Redis, in that order.
 *
 * The message broker is left out on purpose (ADR-0007, "Readiness and shutdown"). A broker outage
 * only delays publishing while the outbox keeps the events, and the relay runs in every replica,
 * so a broker check would take every replica out of rotation at once. The function takes no relay
 * or publisher, so a broker check cannot be added without changing its signature.
 *
 * @param sources - The Postgres pool and the Redis client the service already owns.
 * @returns The dependency checks, to hand to the health router.
 */
export function createReadinessChecks(sources: ReadinessCheckSources): readonly DependencyCheck[] {
  return [createPostgresCheck(sources.pool), createRedisCheck(sources.redis)];
}
