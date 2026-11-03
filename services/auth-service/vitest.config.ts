import path from 'node:path';

import { defineConfig } from 'vitest/config';

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const CONTAINER_START_TIMEOUT_MS = 120_000;

export default defineConfig({
  // Tests import production code as `@/...` (the same mapping as `paths` in tsconfig.json).
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(import.meta.dirname, 'src')}/` }],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        // Needs Docker: one Postgres container is shared by every integration test file.
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['./test/support/integration-global-setup.ts'],
          fileParallelism: false,
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          hookTimeout: CONTAINER_START_TIMEOUT_MS,
        },
      },
    ],
  },
});
