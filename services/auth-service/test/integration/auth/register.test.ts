import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaUnitOfWork } from '@/repositories/prisma-unit-of-work';
import { createTestApp } from '../../support/create-test-app';
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

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
  app = createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: new PrismaUnitOfWork(database.prisma),
            passwordHasher: new Argon2idPasswordHasher(),
            breachedPasswordChecker: new DenylistBreachedPasswordChecker(),
            logger,
          }),
        }),
      ],
    },
  ).app;
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
  });
});
