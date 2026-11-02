import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { EmailAlreadyRegisteredError } from '../users/email-already-registered.error';
import {
  buildUserInput,
  createTestDatabase,
  type TestDatabase,
} from '../test-support/test-database';

const BUILT_IN_ROLE_KEYS = ['ADMIN', 'CUSTOMER', 'OPERATOR', 'SUPPORT_AGENT'];
const TIMESTAMP_RESOLUTION_WAIT_MS = 10;

let database: TestDatabase;
let customerRoleId: string;

/**
 * @param milliseconds - How long to wait.
 * @returns A promise that resolves after the wait, so later timestamps are strictly newer.
 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  customerRoleId = await database.findRoleId('CUSTOMER');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
});

describe('migration seed data', () => {
  it('creates the four built-in roles as system roles', async () => {
    const roles = await database.prisma.role.findMany({ orderBy: { key: 'asc' } });

    expect(roles.map((role) => role.key)).toEqual(BUILT_IN_ROLE_KEYS);
    expect(roles.every((role) => role.isSystem)).toBe(true);
  });
});

describe('PrismaUserRepository.create', () => {
  it('stores an active user with generated id and timestamps', async () => {
    const input = buildUserInput(customerRoleId, { phone: '+919876543210' });

    const user = await database.unitOfWork.run((tx) => database.userRepository.create(input, tx));

    expect(user).toMatchObject({
      email: input.email,
      passwordHash: input.passwordHash,
      name: input.name,
      phone: '+919876543210',
      roleId: customerRoleId,
      tenantId: null,
      status: 'ACTIVE',
      emailVerifiedAt: null,
    });
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts a user without a password yet', async () => {
    const input = buildUserInput(customerRoleId, { passwordHash: null });

    const user = await database.unitOfWork.run((tx) => database.userRepository.create(input, tx));

    expect(user.passwordHash).toBeNull();
  });

  it('throws EmailAlreadyRegisteredError for a duplicate email', async () => {
    const input = buildUserInput(customerRoleId);
    await database.unitOfWork.run((tx) => database.userRepository.create(input, tx));

    const duplicate = database.unitOfWork.run((tx) =>
      database.userRepository.create({ ...input, name: 'Someone Else' }, tx),
    );

    await expect(duplicate).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
  });

  it('rejects a role that does not exist', async () => {
    const input = buildUserInput(randomUUID());

    const creation = database.unitOfWork.run((tx) => database.userRepository.create(input, tx));

    await expect(creation).rejects.toThrow();
  });

  it('rejects an email that is not normalized, even if the service forgot to normalize it', async () => {
    const input = buildUserInput(customerRoleId, { email: 'Mixed.Case@Example.com' });

    const creation = database.unitOfWork.run((tx) => database.userRepository.create(input, tx));

    await expect(creation).rejects.toThrow(/users_email_normalized_check/);
  });
});

describe('PrismaUserRepository reads', () => {
  it('finds a user by id and by normalized email', async () => {
    const input = buildUserInput(customerRoleId);
    const created = await database.unitOfWork.run((tx) =>
      database.userRepository.create(input, tx),
    );

    expect(await database.userRepository.findById(created.id)).toEqual(created);
    expect(await database.userRepository.findByEmail(input.email)).toEqual(created);
  });

  it('returns null when nothing matches', async () => {
    expect(await database.userRepository.findById(randomUUID())).toBeNull();
    expect(await database.userRepository.findByEmail('nobody@example.com')).toBeNull();
  });

  it('sees uncommitted writes of its own transaction', async () => {
    const input = buildUserInput(customerRoleId);

    const found = await database.unitOfWork.run(async (tx) => {
      await database.userRepository.create(input, tx);
      return database.userRepository.findByEmail(input.email, tx);
    });

    expect(found?.email).toBe(input.email);
  });
});

describe('PrismaUserRepository updates', () => {
  it('changes the password hash and bumps updatedAt', async () => {
    const created = await database.unitOfWork.run((tx) =>
      database.userRepository.create(buildUserInput(customerRoleId), tx),
    );
    await wait(TIMESTAMP_RESOLUTION_WAIT_MS);

    const wasUpdated = await database.unitOfWork.run((tx) =>
      database.userRepository.updatePasswordHash(created.id, '$argon2id$new-hash', tx),
    );

    const reloaded = await database.userRepository.findById(created.id);
    expect(wasUpdated).toBe(true);
    expect(reloaded?.passwordHash).toBe('$argon2id$new-hash');
    expect(reloaded?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('disables and re-enables a user', async () => {
    const created = await database.unitOfWork.run((tx) =>
      database.userRepository.create(buildUserInput(customerRoleId), tx),
    );

    await database.unitOfWork.run((tx) =>
      database.userRepository.updateStatus(created.id, 'DISABLED', tx),
    );
    expect((await database.userRepository.findById(created.id))?.status).toBe('DISABLED');

    await database.unitOfWork.run((tx) =>
      database.userRepository.updateStatus(created.id, 'ACTIVE', tx),
    );
    expect((await database.userRepository.findById(created.id))?.status).toBe('ACTIVE');
  });

  it('keeps the earliest email verification time', async () => {
    const created = await database.unitOfWork.run((tx) =>
      database.userRepository.create(buildUserInput(customerRoleId), tx),
    );
    const firstVerification = new Date('2026-11-01T10:00:00.000Z');
    const laterVerification = new Date('2026-11-02T10:00:00.000Z');

    await database.unitOfWork.run((tx) =>
      database.userRepository.markEmailVerified(created.id, firstVerification, tx),
    );
    const wasFound = await database.unitOfWork.run((tx) =>
      database.userRepository.markEmailVerified(created.id, laterVerification, tx),
    );

    const reloaded = await database.userRepository.findById(created.id);
    expect(wasFound).toBe(true);
    expect(reloaded?.emailVerifiedAt).toEqual(firstVerification);
  });

  it('reports false for a user that does not exist', async () => {
    const missingId = randomUUID();

    const results = await database.unitOfWork.run(async (tx) => [
      await database.userRepository.updatePasswordHash(missingId, '$argon2id$x', tx),
      await database.userRepository.updateStatus(missingId, 'DISABLED', tx),
      await database.userRepository.markEmailVerified(missingId, new Date(), tx),
    ]);

    expect(results).toEqual([false, false, false]);
  });
});
