import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

const ENV_FILE = '.env';

// The Prisma CLI no longer reads `.env` itself. The service's own runtime validates its
// environment in src/config.ts; this file only feeds the CLI (generate, migrate).
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` does not connect, so the URL may be missing there (install, CI).
    url: process.env.DATABASE_URL ?? '',
  },
});
