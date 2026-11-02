import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { type TestProject } from 'vitest/node';

/** Same tag as infra/docker/docker-compose.yml, so tests run against the version we deploy. */
const POSTGRES_IMAGE = 'postgres:17.11-alpine';
const MIGRATIONS_DIRECTORY = path.resolve(import.meta.dirname, '../../prisma/migrations');
const MIGRATION_FILE_NAME = 'migration.sql';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of the throwaway Postgres started for this test run. */
    databaseUrl: string;
  }
}

/**
 * Applies every Prisma migration, in order, to a database. Running the real SQL files tests the
 * migrations themselves, including the hand-written constraints and seed rows.
 *
 * @param databaseUrl - Connection URL of an empty database.
 */
async function applyMigrations(databaseUrl: string): Promise<void> {
  const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const migrationName of migrationNames) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIRECTORY, migrationName, MIGRATION_FILE_NAME),
        'utf8',
      );
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

/**
 * Vitest global setup: starts one Postgres container, migrates it, and shares its URL with the
 * test files through `inject('databaseUrl')`.
 *
 * @param project - The Vitest project that runs the integration tests.
 * @returns A teardown function that stops the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const databaseUrl = container.getConnectionUri();
  await applyMigrations(databaseUrl);
  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await container.stop();
  };
}
