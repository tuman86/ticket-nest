import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { type PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/repositories/create-prisma-client';
import { PrismaRefreshTokenRepository } from '@/repositories/prisma-refresh-token.repository';
import { PrismaRoleRepository } from '@/repositories/prisma-role.repository';
import { PrismaUnitOfWork } from '@/repositories/prisma-unit-of-work';
import { PrismaUserRepository } from '@/repositories/prisma-user.repository';
import { type CreateRefreshTokenInput } from '@/repositories/refresh-token.repository';
import { type CreateUserInput } from '@/repositories/user.repository';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 7 * DAY_MS;

export interface TestDatabase {
  readonly pool: Pool;
  readonly prisma: PrismaClient;
  readonly unitOfWork: PrismaUnitOfWork;
  readonly userRepository: PrismaUserRepository;
  readonly roleRepository: PrismaRoleRepository;
  readonly refreshTokenRepository: PrismaRefreshTokenRepository;
  /**
   * Empties the tables tests write to. The seeded roles are kept.
   */
  resetTables(): Promise<void>;
  /**
   * @param key - A built-in role key such as `CUSTOMER`.
   * @returns The role's id.
   */
  findRoleId(key: string): Promise<string>;
  /**
   * Closes the Prisma client and the pool.
   */
  close(): Promise<void>;
}

/**
 * Connects the real repositories to the test container's database.
 *
 * @param databaseUrl - The URL from `inject('databaseUrl')`.
 * @returns The wired repositories and helpers.
 */
export function createTestDatabase(databaseUrl: string): TestDatabase {
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = createPrismaClient(pool);

  return {
    pool,
    prisma,
    unitOfWork: new PrismaUnitOfWork(prisma),
    userRepository: new PrismaUserRepository(prisma),
    roleRepository: new PrismaRoleRepository(prisma),
    refreshTokenRepository: new PrismaRefreshTokenRepository(prisma),
    async resetTables() {
      await pool.query('TRUNCATE TABLE refresh_tokens, users CASCADE');
    },
    async findRoleId(key) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      return role.id;
    },
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/**
 * @param roleId - Role of the new user.
 * @param overrides - Fields to change from the defaults.
 * @returns Valid input for `UserRepository.create` with a unique email.
 */
export function buildUserInput(
  roleId: string,
  overrides: Partial<CreateUserInput> = {},
): CreateUserInput {
  return {
    email: `user-${randomUUID()}@example.com`,
    passwordHash: '$argon2id$test-hash',
    name: 'Test User',
    phone: null,
    roleId,
    tenantId: null,
    ...overrides,
  };
}

/**
 * @param userId - Owner of the token.
 * @param overrides - Fields to change from the defaults.
 * @returns Valid input for `RefreshTokenRepository.create` with a unique hash and a new family.
 */
export function buildRefreshTokenInput(
  userId: string,
  overrides: Partial<CreateRefreshTokenInput> = {},
): CreateRefreshTokenInput {
  const now = Date.now();
  return {
    userId,
    familyId: randomUUID(),
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    authTime: new Date(now),
    expiresAt: new Date(now + REFRESH_TTL_MS),
    userAgent: null,
    ip: null,
    ...overrides,
  };
}
