import { randomUUID } from 'node:crypto';

import {
  fetchMessages,
  openTestConnection,
  sleep,
  waitForConnectionCount,
  waitForExchange,
} from '@ticketnest/messaging/testing/rabbitmq';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { Argon2idPasswordHasher } from '@/auth/argon2id-password-hasher';
import { createAuthRouter } from '@/auth/auth.router';
import { DenylistBreachedPasswordChecker } from '@/auth/denylist-breached-password-checker';
import { RegisterService } from '@/auth/register.service';
import { composeOutboxRelay, type OutboxRelayHandle } from '@/compose-outbox-relay';

import { createTestApp, type TestApp } from '../../support/create-test-app';
import {
  createUnusedLoginService,
  createUnusedLogoutService,
  createUnusedRefreshService,
} from '../../support/create-unused-auth-services';
import { createDatabaseUserRegisteredRecorder } from '../../support/create-user-registered-event-recorder';
import { createPassThroughRateLimiters } from '../../support/pass-through-rate-limiters';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const REGISTER_PATH = '/v1/auth/register';
const PASSWORD = 'correct-horse-battery';
const EXCHANGE_NAME = 'auth.events';
const UNROUTED_QUEUE_NAME = 'auth.unrouted';
const ROUTING_KEY = 'user.registered';
const DEFAULT_VHOST = '/';
const BROKER_LOST_LOG_MESSAGE = 'broker connection lost, backing off';
/** Port 1 is never open, so a connection to it is refused at once. The credentials are made up so a leak is unmistakable. */
const UNREACHABLE_BROKER_USER = 'probe-user';
const UNREACHABLE_BROKER_PASSWORD = 'probe-pw';
const UNREACHABLE_BROKER_VHOST = 'probe-vhost';
const UNREACHABLE_BROKER_URL = `amqp://${UNREACHABLE_BROKER_USER}:${UNREACHABLE_BROKER_PASSWORD}@127.0.0.1:1/${UNREACHABLE_BROKER_VHOST}`;
const RELAY_POLL_INTERVAL_MS = 100;
const RELAY_BATCH_SIZE = 50;
const WAIT_POLL_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 15_000;
/** Long enough for several relay ticks, so a row that stays unpublished is not just slow. */
const QUIET_PERIOD_MS = 800;
/** The test's own connection plus the one the publisher opens. */
const CONNECTIONS_WHILE_RELAY_RUNS = 2;
const CONNECTIONS_AFTER_RELAY_CLOSES = 1;

/** The parts of the published envelope that these tests read. */
const publishedEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  aggregateId: z.string(),
  correlationId: z.string(),
  data: z.record(z.string(), z.unknown()),
});

type TestConnection = Awaited<ReturnType<typeof openTestConnection>>;
type TestChannel = Awaited<ReturnType<TestConnection['createChannel']>>;
type FetchedMessage = Awaited<ReturnType<typeof fetchMessages>>[number];

let database: TestDatabase;
let testApp: TestApp;
let connection: TestConnection;
let channel: TestChannel;
let relay: OutboxRelayHandle | undefined;
let queueName: string;

/**
 * @returns The real register route on the real database, with the real outbox recorder.
 */
function buildRegisterApp(): TestApp {
  return createTestApp(
    {},
    {
      buildRouters: (logger) => [
        createAuthRouter({
          rateLimiters: createPassThroughRateLimiters(),
          registerService: new RegisterService({
            userRepository: database.userRepository,
            roleRepository: database.roleRepository,
            unitOfWork: database.unitOfWork,
            userRegisteredEventRecorder: createDatabaseUserRegisteredRecorder(database),
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
  );
}

/**
 * Polls until a condition holds.
 *
 * @param isDone - Returns true once the condition holds.
 * @param description - What is awaited, for the timeout message.
 * @throws Error when the condition does not hold within `WAIT_TIMEOUT_MS`.
 */
async function waitUntil(isDone: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await isDone())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

/**
 * Builds the relay the way production does, with the test's Prisma client, and starts it.
 *
 * @param brokerUrl - The broker the relay publishes to.
 * @returns The running relay. The test's `afterEach` closes it.
 */
function startRelay(brokerUrl: string): OutboxRelayHandle {
  const handle = composeOutboxRelay({
    config: {
      OUTBOX_RELAY_ENABLED: true,
      RABBITMQ_URL: brokerUrl,
      OUTBOX_RELAY_POLL_INTERVAL_MS: RELAY_POLL_INTERVAL_MS,
      OUTBOX_RELAY_BATCH_SIZE: RELAY_BATCH_SIZE,
    },
    prisma: database.prisma,
    logger: testApp.logger,
  });
  handle.start();
  relay = handle;
  return handle;
}

/**
 * Starts the relay, waits until it has declared the exchange, then binds a queue of the test's own
 * to it, so the next event that the relay publishes is routed to that queue.
 *
 * @returns The running relay.
 */
async function startRelayWithBoundQueue(): Promise<OutboxRelayHandle> {
  const handle = startRelay(inject('amqpUrl'));
  await waitForExchange(connection, EXCHANGE_NAME);
  await channel.assertQueue(queueName);
  await channel.bindQueue(queueName, EXCHANGE_NAME, ROUTING_KEY);
  return handle;
}

/**
 * Closes the relay's shutdown resources in the order the service closes them.
 *
 * @param handle - The relay to close.
 */
async function closeRelay(handle: OutboxRelayHandle): Promise<void> {
  for (const resource of handle.resources) {
    await resource.close();
  }
}

/**
 * Registers a user over HTTP.
 *
 * @param email - The new account's email.
 * @param requestId - The `X-Request-Id` to send, which becomes the event's correlation id.
 * @returns The new user's id.
 */
async function registerUser(email: string, requestId: string): Promise<string> {
  const response = await request(testApp.app)
    .post(REGISTER_PATH)
    .set('X-Request-Id', requestId)
    .send({ email, password: PASSWORD, name: 'Asha Rao' });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

/**
 * @param queue - The queue to read.
 * @returns The one message that arrives on it.
 * @throws Error when no message arrives in time.
 */
async function fetchOneMessage(queue: string): Promise<FetchedMessage> {
  const [message] = await fetchMessages(channel, queue, 1);
  if (message === undefined) {
    throw new Error(`No message arrived on ${queue}.`);
  }
  return message;
}

/**
 * @param message - A message the relay published.
 * @returns Its body, parsed as the envelope fields these tests read.
 */
function readEnvelope(message: FetchedMessage): z.infer<typeof publishedEnvelopeSchema> {
  return publishedEnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
}

/**
 * @param userId - The user whose event row to look up.
 * @returns The outbox row of that user's `user.registered` event.
 */
function findOutboxRow(userId: string) {
  return database.prisma.outbox.findFirstOrThrow({ where: { aggregateId: userId } });
}

beforeAll(async () => {
  database = createTestDatabase(inject('databaseUrl'));
  testApp = buildRegisterApp();
  connection = await openTestConnection(inject('amqpUrl'));
  channel = await connection.createChannel();
  channel.on('error', () => undefined);
});

afterAll(async () => {
  await connection.close();
  await database.close();
});

beforeEach(async () => {
  await database.resetTables();
  queueName = `auth-e2e-${randomUUID()}`;
});

afterEach(async () => {
  if (relay !== undefined) {
    await closeRelay(relay);
    relay = undefined;
  }
  await channel.deleteQueue(queueName);
});

describe('register -> outbox -> relay -> RabbitMQ', () => {
  it('publishes user.registered to a queue bound to auth.events after a register', async () => {
    await startRelayWithBoundQueue();

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    const message = await fetchOneMessage(queueName);
    expect(message.fields.exchange).toBe(EXCHANGE_NAME);
    expect(message.fields.routingKey).toBe(ROUTING_KEY);
    expect(readEnvelope(message)).toMatchObject({ type: ROUTING_KEY, aggregateId: userId });
  });

  it('publishes a body whose data holds exactly userId, roleKey and registeredAt', async () => {
    await startRelayWithBoundQueue();

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    const { data } = readEnvelope(await fetchOneMessage(queueName));
    expect(Object.keys(data).sort()).toEqual(['registeredAt', 'roleKey', 'userId']);
    expect(data).toMatchObject({ userId, roleKey: 'CUSTOMER' });
  });

  it('sets published_at on the outbox row after the broker confirmed', async () => {
    await startRelayWithBoundQueue();

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    await fetchOneMessage(queueName);
    await waitUntil(async () => (await findOutboxRow(userId)).publishedAt !== null, 'published_at');
    expect(await findOutboxRow(userId)).toMatchObject({ attempts: 0, failedAt: null });
  });

  it("uses the outbox row id as the AMQP message id and the request's id as correlation id", async () => {
    await startRelayWithBoundQueue();

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    const message = await fetchOneMessage(queueName);
    const row = await findOutboxRow(userId);
    expect(message.properties.messageId).toBe(row.id);
    expect(message.properties.correlationId).toBe('req-e2e-1');
    expect(readEnvelope(message).correlationId).toBe('req-e2e-1');
  });

  it('keeps the event in auth.unrouted when no queue is bound', async () => {
    startRelay(inject('amqpUrl'));
    await waitForExchange(connection, EXCHANGE_NAME);

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    const message = await fetchOneMessage(UNROUTED_QUEUE_NAME);
    expect(message.fields.routingKey).toBe(ROUTING_KEY);
    expect(readEnvelope(message).aggregateId).toBe(userId);
  });

  it('accepts the registration and leaves the row unpublished while the broker is unreachable', async () => {
    startRelay(UNREACHABLE_BROKER_URL);

    const userId = await registerUser('asha@example.com', 'req-e2e-1');

    await waitUntil(
      () => Promise.resolve(testApp.lines.some((line) => line.msg === BROKER_LOST_LOG_MESSAGE)),
      'the relay to notice the broker is down',
    );
    await sleep(QUIET_PERIOD_MS);
    expect(await findOutboxRow(userId)).toMatchObject({
      publishedAt: null,
      attempts: 0,
      failedAt: null,
    });
  });

  it('never writes the broker URL, its credentials or its vhost to the log while the broker is unreachable', async () => {
    startRelay(UNREACHABLE_BROKER_URL);
    await registerUser('asha@example.com', 'req-e2e-1');
    await waitUntil(
      () => Promise.resolve(testApp.lines.some((line) => line.msg === BROKER_LOST_LOG_MESSAGE)),
      'the relay to notice the broker is down',
    );
    await sleep(QUIET_PERIOD_MS);

    const log = JSON.stringify(testApp.lines);
    expect(log).not.toContain(UNREACHABLE_BROKER_USER);
    expect(log).not.toContain(UNREACHABLE_BROKER_PASSWORD);
    expect(log).not.toContain(UNREACHABLE_BROKER_VHOST);
  });

  it('ends the loop and drops the broker connection when the relay resources close in order', async () => {
    const handle = await startRelayWithBoundQueue();
    expect(
      await waitForConnectionCount(
        inject('managementUrl'),
        DEFAULT_VHOST,
        CONNECTIONS_WHILE_RELAY_RUNS,
      ),
    ).toBe(CONNECTIONS_WHILE_RELAY_RUNS);

    await registerUser('asha@example.com', 'req-e2e-1');
    await fetchOneMessage(queueName);
    await closeRelay(handle);

    expect(
      await waitForConnectionCount(
        inject('managementUrl'),
        DEFAULT_VHOST,
        CONNECTIONS_AFTER_RELAY_CLOSES,
      ),
    ).toBe(CONNECTIONS_AFTER_RELAY_CLOSES);
    const laterUserId = await registerUser('ravi@example.com', 'req-e2e-2');
    await sleep(QUIET_PERIOD_MS);
    expect((await findOutboxRow(laterUserId)).publishedAt).toBeNull();
  });
});
