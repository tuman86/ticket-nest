import { type DependencyCheck } from './dependency-check';

/** The slice of a `pg` pool that the readiness check uses. It keeps this package free of `pg`. */
export interface Queryable {
  query: (text: string) => Promise<unknown>;
}

/**
 * Builds the readiness check of a service's own Postgres database. It runs `SELECT 1` through the
 * pool, so a lost connection, a refused login or an exhausted pool all show up as "down".
 *
 * @param pool - The service's `pg` pool (or anything with a `query(text)` method).
 * @returns A check named `postgres`, which rejects when the database does not answer.
 */
export function createPostgresCheck(pool: Queryable): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await pool.query('SELECT 1');
    },
  };
}
