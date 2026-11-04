import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests import production code as `@/...` (the same mapping as `paths` in tsconfig.json).
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(import.meta.dirname, 'src')}/` }],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
