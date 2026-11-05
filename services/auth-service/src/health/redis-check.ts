import { type DependencyCheck } from '@ticketnest/service-runtime';

/** The slice of a Redis client that the readiness check uses. */
export interface Pingable {
  ping: () => Promise<string>;
}

export function createRedisCheck(client: Pingable): DependencyCheck {
  return {
    name: 'redis',
    check: async () => {
      await client.ping();
    },
  };
}
