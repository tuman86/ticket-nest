import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { composeOutboxRelay, type OutboxRelayHandle } from '@/compose-outbox-relay';
import { createReadinessChecks } from '@/health/create-readiness-checks';

import { createTestApp, type TestApp } from '../../support/create-test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const READY_PATH = '/health/ready';
/** Port 1 is never open, so every connection attempt is refused at once. */
const UNREACHABLE_BROKER_URL = 'amqp://probe-user:probe-pw@127.0.0.1:1/probe-vhost';
const BROKER_LOST_LOG_MESSAGE = 'broker connection lost, backing off';
const RELAY_POLL_INTERVAL_MS = 100;
const RELAY_BATCH_SIZE = 50;
const WAIT_POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 10_000;

let database: TestDatabase;
let redis: Redis;
let testApp: TestApp;
let relay: OutboxRelayHandle | undefined;

/**
 * Polls until the log shows that the relay found the broker unreachable, so the request that
 * follows is made while the broker is known to be down.
 *
 * @throws Error when the relay does not notice within `WAIT_TIMEOUT_MS`.
 */
async function waitForBrokerLost(): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!testApp.lines.some((line) => line.msg === BROKER_LOST_LOG_MESSAGE)) {
    if (Date.now() >= deadline) {
      throw new Error('The relay did not report the broker as lost.');
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
}

beforeAll(() => {
  database = createTestDatabase(inject('databaseUrl'));
  redis = new Redis(inject('redisUrl'));
  testApp = createTestApp({
    readinessChecks: createReadinessChecks({ pool: database.pool, redis }),
  });
});

afterEach(async () => {
  for (const resource of relay?.resources ?? []) {
    await resource.close();
  }
  relay = undefined;
});

afterAll(async () => {
  await redis.quit();
  await database.close();
});

describe('GET /health/ready while the broker is down', () => {
  it('answers 200 with only Postgres and Redis in the report', async () => {
    relay = composeOutboxRelay({
      config: {
        OUTBOX_RELAY_ENABLED: true,
        RABBITMQ_URL: UNREACHABLE_BROKER_URL,
        OUTBOX_RELAY_POLL_INTERVAL_MS: RELAY_POLL_INTERVAL_MS,
        OUTBOX_RELAY_BATCH_SIZE: RELAY_BATCH_SIZE,
      },
      prisma: database.prisma,
      logger: testApp.logger,
    });
    relay.start();
    await waitForBrokerLost();

    const response = await request(testApp.app).get(READY_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });
});
