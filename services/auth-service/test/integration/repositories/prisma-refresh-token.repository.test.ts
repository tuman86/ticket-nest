import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type RefreshTokenRecord } from '@/repositories/refresh-token.repository';
import {
  buildRefreshTokenInput,
  buildUserInput,
  createTestDatabase,
  type TestDatabase,
} from '../../support/test-database';

const HOUR_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 2;

let database: TestDatabase;
let userId: string;

/**
 * Stores a token for the test user.
 *
 * @param overrides - Fields to change from the defaults.
 * @returns The stored token.
 */
function createToken(
  overrides: Parameters<typeof buildRefreshTokenInput>[1] = {},
): Promise<RefreshTokenRecord> {
  return database.unitOfWork.run((tx) =>
    database.refreshTokenRepository.create(buildRefreshTokenInput(userId, overrides), tx),
  );
}

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
  const user = await database.unitOfWork.run(async (tx) =>
    database.userRepository.create(buildUserInput(await database.findRoleId('CUSTOMER')), tx),
  );
  userId = user.id;
});

describe('PrismaRefreshTokenRepository.create and findByTokenHash', () => {
  it('stores a token and finds it by hash', async () => {
    const created = await createToken({ userAgent: 'Mozilla/5.0', ip: '203.0.113.7' });

    const found = await database.refreshTokenRepository.findByTokenHash(created.tokenHash);

    expect(found).toEqual(created);
    expect(created).toMatchObject({
      userId,
      rotatedAt: null,
      replacedById: null,
      revokedAt: null,
      userAgent: 'Mozilla/5.0',
      ip: '203.0.113.7',
    });
  });

  it('returns null for an unknown hash', async () => {
    const found = await database.refreshTokenRepository.findByTokenHash('0'.repeat(64));

    expect(found).toBeNull();
  });

  it('rejects a duplicate hash', async () => {
    const created = await createToken();

    const duplicate = createToken({ tokenHash: created.tokenHash });

    await expect(duplicate).rejects.toThrow();
  });

  it('rejects a value that is not a SHA-256 hex digest', async () => {
    const invalid = createToken({ tokenHash: 'not-a-hash' });

    await expect(invalid).rejects.toThrow();
  });
});

describe('PrismaRefreshTokenRepository.markRotated', () => {
  it('links the token to its successor exactly once', async () => {
    const familyId = randomUUID();
    const original = await createToken({ familyId });
    const successor = await createToken({ familyId });
    const rotatedAt = new Date();

    const first = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.markRotated(original.id, successor.id, rotatedAt, tx),
    );
    const second = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.markRotated(original.id, successor.id, rotatedAt, tx),
    );

    const reloaded = await database.refreshTokenRepository.findByTokenHash(original.tokenHash);
    expect([first, second]).toEqual([true, false]);
    expect(reloaded).toMatchObject({ replacedById: successor.id, rotatedAt });
  });

  it('lets exactly one of two concurrent rotations win', async () => {
    const familyId = randomUUID();
    const original = await createToken({ familyId });
    const successorA = await createToken({ familyId });
    const successorB = await createToken({ familyId });

    const results = await Promise.all([
      database.unitOfWork.run((tx) =>
        database.refreshTokenRepository.markRotated(original.id, successorA.id, new Date(), tx),
      ),
      database.unitOfWork.run((tx) =>
        database.refreshTokenRepository.markRotated(original.id, successorB.id, new Date(), tx),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to rotate a revoked token', async () => {
    const original = await createToken();
    const successor = await createToken();
    await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.revokeFamily(original.familyId, new Date(), tx),
    );

    const wasRotated = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.markRotated(original.id, successor.id, new Date(), tx),
    );

    expect(wasRotated).toBe(false);
  });

  it('rolls back both the new token and the rotation when the transaction fails', async () => {
    const original = await createToken();
    const successorHash = buildRefreshTokenInput(userId).tokenHash;

    const rotation = database.unitOfWork.run(async (tx) => {
      const successor = await database.refreshTokenRepository.create(
        buildRefreshTokenInput(userId, { familyId: original.familyId, tokenHash: successorHash }),
        tx,
      );
      await database.refreshTokenRepository.markRotated(original.id, successor.id, new Date(), tx);
      throw new Error('simulated failure after rotation');
    });

    await expect(rotation).rejects.toThrow('simulated failure after rotation');
    expect(await database.refreshTokenRepository.findByTokenHash(successorHash)).toBeNull();
    const reloaded = await database.refreshTokenRepository.findByTokenHash(original.tokenHash);
    expect(reloaded).toMatchObject({ rotatedAt: null, replacedById: null });
  });
});

describe('PrismaRefreshTokenRepository revocation', () => {
  it('revokes only the tokens of one family', async () => {
    const familyId = randomUUID();
    const first = await createToken({ familyId });
    const second = await createToken({ familyId });
    const otherFamily = await createToken();
    const revokedAt = new Date();

    const count = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.revokeFamily(familyId, revokedAt, tx),
    );

    expect(count).toBe(2);
    const reloaded = await Promise.all(
      [first, second, otherFamily].map((token) =>
        database.refreshTokenRepository.findByTokenHash(token.tokenHash),
      ),
    );
    expect(reloaded.map((token) => token?.revokedAt)).toEqual([revokedAt, revokedAt, null]);
  });

  it('does not count tokens that were already revoked', async () => {
    const token = await createToken();
    const firstRevocation = new Date('2026-11-01T10:00:00.000Z');
    await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.revokeFamily(token.familyId, firstRevocation, tx),
    );

    const count = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.revokeFamily(token.familyId, new Date(), tx),
    );

    const reloaded = await database.refreshTokenRepository.findByTokenHash(token.tokenHash);
    expect(count).toBe(0);
    expect(reloaded?.revokedAt).toEqual(firstRevocation);
  });

  it('revokes every token of a user across families, leaving other users alone', async () => {
    await createToken();
    await createToken();
    const otherUser = await database.unitOfWork.run(async (tx) =>
      database.userRepository.create(buildUserInput(await database.findRoleId('CUSTOMER')), tx),
    );
    const otherToken = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.create(buildRefreshTokenInput(otherUser.id), tx),
    );

    const count = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.revokeAllForUser(userId, new Date(), tx),
    );

    const reloaded = await database.refreshTokenRepository.findByTokenHash(otherToken.tokenHash);
    expect(count).toBe(2);
    expect(reloaded?.revokedAt).toBeNull();
  });
});

describe('PrismaRefreshTokenRepository.deleteExpired', () => {
  it('deletes only expired tokens, oldest first, up to the limit', async () => {
    const now = Date.now();
    const oldest = await createToken({ expiresAt: new Date(now - 3 * HOUR_MS) });
    const older = await createToken({ expiresAt: new Date(now - 2 * HOUR_MS) });
    const expired = await createToken({ expiresAt: new Date(now - HOUR_MS) });
    const active = await createToken({ expiresAt: new Date(now + HOUR_MS) });

    const deleted = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.deleteExpired(new Date(now), BATCH_LIMIT, tx),
    );

    expect(deleted).toBe(BATCH_LIMIT);
    const remaining = await Promise.all(
      [oldest, older, expired, active].map((token) =>
        database.refreshTokenRepository.findByTokenHash(token.tokenHash),
      ),
    );
    expect(remaining.map((token) => token !== null)).toEqual([false, false, true, true]);
  });

  it('deletes nothing when no token has expired', async () => {
    await createToken();

    const deleted = await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.deleteExpired(new Date(), BATCH_LIMIT, tx),
    );

    expect(deleted).toBe(0);
  });
});

describe('PrismaRefreshTokenRepository foreign keys', () => {
  it('deletes a user’s tokens together with the user', async () => {
    const token = await createToken();

    await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);

    expect(await database.refreshTokenRepository.findByTokenHash(token.tokenHash)).toBeNull();
  });

  it('clears the link when the successor is deleted', async () => {
    const familyId = randomUUID();
    const original = await createToken({ familyId });
    const successor = await createToken({ familyId });
    await database.unitOfWork.run((tx) =>
      database.refreshTokenRepository.markRotated(original.id, successor.id, new Date(), tx),
    );

    await database.pool.query('DELETE FROM refresh_tokens WHERE id = $1', [successor.id]);

    const reloaded = await database.refreshTokenRepository.findByTokenHash(original.tokenHash);
    expect(reloaded?.replacedById).toBeNull();
  });
});
