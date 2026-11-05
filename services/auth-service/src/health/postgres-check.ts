import { type DependencyCheck } from '@ticketnest/service-runtime';

/** The slice of a `pg` pool that the readiness check uses. */
export interface Queryable {
  query: (text: string) => Promise<unknown>;
}

export function createPostgresCheck(pool: Queryable): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await pool.query('SELECT 1');
    },
  };
}
