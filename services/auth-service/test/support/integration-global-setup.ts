import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import { Client } from 'pg';
import { type TestProject } from 'vitest/node';

/** Same tag as infra/docker/docker-compose.yml, so tests run against the version we deploy. */
const POSTGRES_IMAGE = 'postgres:17.11-alpine';
const REDIS_IMAGE = 'redis:8.10.3-alpine';
const REDIS_PORT = 6379;
const REDIS_READY_MESSAGE = 'Ready to accept connections';
const MIGRATIONS_DIRECTORY = path.resolve(import.meta.dirname, '../../prisma/migrations');
const MIGRATION_FILE_NAME = 'migration.sql';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of the throwaway Postgres started for this test run. */
    databaseUrl: string;
    /** Connection URL of the throwaway Redis started for this test run. */
    redisUrl: string;
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
 * Vitest global setup: starts one Postgres container (migrated) and one Redis container, and
 * shares their URLs with the test files through `inject('databaseUrl')` and `inject('redisUrl')`.
 *
 * @param project - The Vitest project that runs the integration tests.
 * @returns A teardown function that stops both containers.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [container, redisContainer] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage(REDIS_READY_MESSAGE))
      .start(),
  ]);
  const databaseUrl = container.getConnectionUri();
  await applyMigrations(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  project.provide(
    'redisUrl',
    `redis://${redisContainer.getHost()}:${String(redisContainer.getMappedPort(REDIS_PORT))}`,
  );

  return async () => {
    await Promise.all([container.stop(), redisContainer.stop()]);
  };
}
