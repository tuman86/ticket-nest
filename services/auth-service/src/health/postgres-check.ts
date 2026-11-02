import { type DependencyCheck } from './dependency-check';

interface Queryable {
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
