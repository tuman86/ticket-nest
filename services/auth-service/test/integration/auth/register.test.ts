import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaUnitOfWork } from '@/repositories/prisma-unit-of-work';
import { createTestApp } from '../../support/create-test-app';
import { createPassThroughRateLimiters } from '../../support/pass-through-rate-limiters';
import {
  createUnusedLoginService,
  createUnusedLogoutService,
  createUnusedRefreshService,
} from '../../support/create-unused-auth-services';
import { FailingOutboxStore } from '../../support/failing-outbox-store';
import { createDatabaseUserRegisteredRecorder } from '../../support/create-user-registered-event-recorder';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { RegisterService } from '@/auth/register.service';

const REGISTER_PATH = '/v1/auth/register';
const PASSWORD = 'correct-horse-battery';
const SIMULTANEOUS_REQUESTS = 6;

let database: TestDatabase;
let app: ReturnType<typeof createTestApp>['app'];

/**
 * @param recorder - The recorder the register service writes its event with.
 * @returns The real register route on the real database, with that recorder.
 */
function buildRegisterApp(
  recorder: ReturnType<typeof createDatabaseUserRegisteredRecorder>,
): ReturnType<typeof createTestApp>['app'] {
  return createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          rateLimiters: createPassThroughRateLimiters(),
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: new PrismaUnitOfWork(database.prisma),
            userRegisteredEventRecorder: recorder,
            passwordHasher: new Argon2idPasswordHasher(),
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
          loginService: createUnusedLoginService(logger),
          refreshService: createUnusedRefreshService(logger),
          logoutService: createUnusedLogoutService(logger),
        }),
      ],
    },
  ).app;
}

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
  app = buildRegisterApp(createDatabaseUserRegisteredRecorder(database));
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
});

describe('POST /v1/auth/register against Postgres', () => {
  it('stores a CUSTOMER with a normalized email and an argon2id hash', async () => {
    const response = await request(app)
      .post(REGISTER_PATH)
      .send({ email: 'Asha@Example.com', password: PASSWORD, name: 'Asha Rao' });

    expect(response.status).toBe(201);
    const stored = await database.prisma.user.findUniqueOrThrow({
      where: { email: 'asha@example.com' },
      include: { role: true },
    });
    expect(stored.id).toBe((response.body as { id: string }).id);
    expect(stored.role.key).toBe('CUSTOMER');
    expect(stored.status).toBe('ACTIVE');
    expect(stored.emailVerifiedAt).toBeNull();
    expect(stored.tenantId).toBeNull();
    expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  it('answers 409 for an existing email and leaves one row', async () => {
    const body = { email: 'asha@example.com', password: PASSWORD, name: 'Asha Rao' };
    await request(app).post(REGISTER_PATH).send(body);

    const response = await request(app)
      .post(REGISTER_PATH)
      .send({ ...body, email: 'ASHA@example.com' });

    expect(response.status).toBe(409);
    expect(await database.prisma.user.count()).toBe(1);
  });

  it('lets exactly one of several simultaneous registrations win; the unique index decides', async () => {
    const attempts = Array.from({ length: SIMULTANEOUS_REQUESTS }, (_, i) =>
      request(app)
        .post(REGISTER_PATH)
        .send({
          email: i % 2 === 0 ? 'race@example.com' : 'RACE@example.com',
          password: PASSWORD,
          name: `Racer ${String(i)}`,
        }),
    );

    const responses = await Promise.all(attempts);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, ...Array<number>(SIMULTANEOUS_REQUESTS - 1).fill(409)]);
    expect(await database.prisma.user.count()).toBe(1);
    expect(await database.prisma.outbox.count()).toBe(1);
  });
});

describe('POST /v1/auth/register: user.registered outbox row against Postgres', () => {
  it('stores one unpublished user.registered row for the new user', async () => {
    const response = await request(app)
      .post(REGISTER_PATH)
      .set('X-Request-Id', 'req-integration-1')
      .send({
        email: 'Asha@Example.com',
        password: PASSWORD,
        name: 'Asha Rao',
        phone: '+919876543210',
      });

    expect(response.status).toBe(201);
    const userId = (response.body as { id: string }).id;
    const rows = await database.prisma.outbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      type: 'user.registered',
      aggregateType: 'user',
      aggregateId: userId,
      aggregateVersion: 1,
      publishedAt: null,
      attempts: 0,
    });
    expect(rows[0]?.payload).toMatchObject({
      type: 'user.registered',
      version: 1,
      aggregateId: userId,
      correlationId: 'req-integration-1',
      causationId: null,
      tenantId: null,
    });
  });

  it('stores exactly the user id, the role key and the registration time as data', async () => {
    const response = await request(app)
      .post(REGISTER_PATH)
      .send({ email: 'asha@example.com', password: PASSWORD, name: 'Asha Rao' });

    const userId = (response.body as { id: string }).id;
    const stored = await database.prisma.outbox.findFirstOrThrow();
    const user = await database.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.payload).toMatchObject({
      data: { userId, roleKey: 'CUSTOMER', registeredAt: user.createdAt.toISOString() },
    });
    const data = (stored.payload as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(['registeredAt', 'roleKey', 'userId']);
  });

  it('keeps the email, name, phone and password hash out of the stored row', async () => {
    await request(app).post(REGISTER_PATH).send({
      email: 'asha@example.com',
      password: PASSWORD,
      name: 'Asha Rao',
      phone: '+919876543210',
    });

    const stored = JSON.stringify(await database.prisma.outbox.findMany()).toLowerCase();
    for (const secret of ['asha', 'rao', '9876543210', 'argon2', PASSWORD]) {
      expect(stored).not.toContain(secret.toLowerCase());
    }
  });

  it('stores no row when the email is already taken', async () => {
    const body = { email: 'asha@example.com', password: PASSWORD, name: 'Asha Rao' };
    await request(app).post(REGISTER_PATH).send(body);

    const response = await request(app).post(REGISTER_PATH).send(body);

    expect(response.status).toBe(409);
    expect(await database.prisma.outbox.count()).toBe(1);
  });

  it('creates no user when the outbox insert fails inside the real transaction', async () => {
    const failingApp = buildRegisterApp(
      createDatabaseUserRegisteredRecorder(database, new FailingOutboxStore()),
    );

    const response = await request(failingApp)
      .post(REGISTER_PATH)
      .send({ email: 'asha@example.com', password: PASSWORD, name: 'Asha Rao' });

    expect(response.status).toBe(500);
    expect(await database.prisma.user.count()).toBe(0);
    expect(await database.prisma.outbox.count()).toBe(0);
  });
});
