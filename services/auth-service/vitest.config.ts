import { defineConfig } from 'vitest/config';

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const CONTAINER_START_TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        // Needs Docker: one Postgres container is shared by every integration test file.
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['./src/test-support/integration-global-setup.ts'],
          fileParallelism: false,
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: CONTAINER_START_TIMEOUT_MS,
        },
      },
    ],
  },
});
