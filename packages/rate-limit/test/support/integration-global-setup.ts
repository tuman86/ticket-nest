import { GenericContainer, Wait } from 'testcontainers';
import { type TestProject } from 'vitest/node';

/** Same tag as infra/docker/docker-compose.yml, so tests run against the version we deploy. */
const REDIS_IMAGE = 'redis:8.10.3-alpine';
const REDIS_PORT = 6379;
const REDIS_READY_MESSAGE = 'Ready to accept connections';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL of the throwaway Redis started for this test run. */
    redisUrl: string;
  }
}

/**
 * Vitest global setup: starts one Redis container and shares its URL with the test files through
 * `inject('redisUrl')`.
 *
 * @param project - The Vitest project that runs the integration tests.
 * @returns A teardown function that stops the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const redisContainer = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage(REDIS_READY_MESSAGE))
    .start();
  project.provide(
    'redisUrl',
    `redis://${redisContainer.getHost()}:${String(redisContainer.getMappedPort(REDIS_PORT))}`,
  );
  return async () => {
    await redisContainer.stop();
  };
}
