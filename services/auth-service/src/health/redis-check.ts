import { type DependencyCheck } from '@ticketnest/service-runtime';

interface Pingable {
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
