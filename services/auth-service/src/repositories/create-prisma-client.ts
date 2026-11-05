import { PrismaPg } from '@prisma/adapter-pg';
import { type Pool } from 'pg';

import { PrismaClient } from '../generated/prisma/client';

/**
 * The service's Prisma client. Re-exported so the composition root can pass it around without
 * importing the generated path, which only `src/repositories/` may do.
 */
export type DatabaseClient = PrismaClient;

/**
 * Builds the Prisma client on top of an existing `pg` pool, so health checks and queries share
 * one set of connections. Called only from the composition root and from tests.
 *
 * @param pool - The service's Postgres pool. The caller still owns it and must close it.
 * @returns A Prisma client that runs its queries through `pool`.
 */
export function createPrismaClient(pool: Pool): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}
