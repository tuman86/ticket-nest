import { randomInt } from 'node:crypto';

import {
  type ChannelModel,
  type ConfirmChannel,
  connect,
  type GetMessage,
  type Options,
  type Channel,
} from 'amqplib';
import { z } from 'zod';

const MANAGEMENT_USER = 'guest';
const MANAGEMENT_PASSWORD = 'guest';
const DEFAULT_VHOST = '/';
const MANAGEMENT_POLL_INTERVAL_MS = 200;
const MANAGEMENT_TIMEOUT_MS = 10_000;
const FETCH_POLL_INTERVAL_MS = 50;
const CONNECTION_COUNT_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 5_000;
const DOMAIN_LENGTH = 12;
const FIRST_LETTER_CODE = 97;
const LETTER_COUNT = 26;

/** The parts of the management API's answer for one queue that the tests read. */
const queueDetailsSchema = z.object({
  type: z.string(),
  durable: z.boolean(),
  arguments: z.record(z.string(), z.unknown()),
});
export type QueueDetails = z.infer<typeof queueDetailsSchema>;

/**
 * Pauses a test.
 *
 * @param milliseconds - How long to wait.
 * @returns A promise that settles after that long.
 */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Makes a producer domain name that no other test uses, so tests share one broker without
 * clashing. A domain may only hold lower-case letters and underscores (`buildEventExchangeName`),
 * so no digits.
 *
 * @returns A new random domain name.
 */
export function createTestDomain(): string {
  return Array.from({ length: DOMAIN_LENGTH }, () =>
    String.fromCharCode(FIRST_LETTER_CODE + randomInt(LETTER_COUNT)),
  ).join('');
}

/**
 * Opens a connection that the test itself owns, separate from the code under test. It listens to
 * `error`, because amqplib would throw an `error` event nobody listens to.
 *
 * @param amqpUrl - The URL from `inject('amqpUrl')`.
 * @returns A connection the test must close.
 */
export async function openTestConnection(amqpUrl: string): Promise<ChannelModel> {
  const connection = await connect(amqpUrl);
  connection.on('error', () => undefined);
  return connection;
}

/**
 * Publishes one message on a confirm channel and waits for the broker's answer.
 *
 * @param channel - A confirm channel.
 * @param exchange - Exchange to publish to (empty for the default exchange).
 * @param routingKey - Routing key, or the queue name on the default exchange.
 * @param body - Message body.
 * @param options - Message properties.
 * @returns Resolves on an ack and rejects on a nack.
 */
export function publishAndConfirm(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  body: Buffer,
  options: Options.Publish = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.publish(exchange, routingKey, body, options, (error) => {
      if (error === null || error === undefined) {
        resolve();
        return;
      }
      reject(error instanceof Error ? error : new Error('The broker nacked the message.'));
    });
  });
}

/**
 * Reads messages from a queue with `basic.get`, retrying until enough have arrived or time runs
 * out. The messages are acknowledged, so they are gone from the queue.
 *
 * @param channel - A channel.
 * @param queueName - The queue to read.
 * @param expectedCount - How many messages to wait for.
 * @param timeoutMs - How long to wait for them.
 * @returns The messages that arrived, at most `expectedCount`.
 */
export async function fetchMessages(
  channel: Channel,
  queueName: string,
  expectedCount: number,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<GetMessage[]> {
  const messages: GetMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (messages.length < expectedCount && Date.now() < deadline) {
    const message = await channel.get(queueName, { noAck: true });
    if (message === false) {
      await sleep(FETCH_POLL_INTERVAL_MS);
    } else {
      messages.push(message);
    }
  }
  return messages;
}

/**
 * Reads a queue's type and arguments from the broker's management API, which is the broker's own
 * record of what the declaration stored. The queue shows up a moment after it is declared, so it
 * retries for a while.
 *
 * @param managementUrl - The URL from `inject('managementUrl')`.
 * @param queueName - The queue to look up.
 * @param vhost - The virtual host the queue is in.
 * @returns What the broker reports for the queue.
 * @throws Error when the queue is not reported within the timeout.
 */
export async function readQueueDetails(
  managementUrl: string,
  queueName: string,
  vhost: string = DEFAULT_VHOST,
): Promise<QueueDetails> {
  const url = `${managementUrl}/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queueName)}`;
  const authorization = `Basic ${Buffer.from(`${MANAGEMENT_USER}:${MANAGEMENT_PASSWORD}`).toString('base64')}`;
  const deadline = Date.now() + MANAGEMENT_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(url, { headers: { authorization } });
    if (response.ok) {
      return queueDetailsSchema.parse(await response.json());
    }
    if (Date.now() >= deadline) {
      throw new Error(`The management API does not report queue ${queueName}.`);
    }
    await sleep(MANAGEMENT_POLL_INTERVAL_MS);
  }
}

const FULL_PERMISSION = '.*';

/**
 * @returns The `Authorization` header value for the management API's `guest` user.
 */
function buildManagementAuthorization(): string {
  return `Basic ${Buffer.from(`${MANAGEMENT_USER}:${MANAGEMENT_PASSWORD}`).toString('base64')}`;
}

/**
 * Creates a virtual host and gives the `guest` user full rights on it, so a test can use a vhost
 * that nothing else touches.
 *
 * @param managementUrl - The URL from `inject('managementUrl')`.
 * @param vhost - The name of the new virtual host.
 * @throws Error when the management API refuses.
 */
export async function createVhost(managementUrl: string, vhost: string): Promise<void> {
  const headers = {
    authorization: buildManagementAuthorization(),
    'content-type': 'application/json',
  };
  const created = await fetch(`${managementUrl}/api/vhosts/${encodeURIComponent(vhost)}`, {
    method: 'PUT',
    headers,
    body: '{}',
  });
  const permitted = await fetch(
    `${managementUrl}/api/permissions/${encodeURIComponent(vhost)}/${MANAGEMENT_USER}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        configure: FULL_PERMISSION,
        write: FULL_PERMISSION,
        read: FULL_PERMISSION,
      }),
    },
  );
  if (!created.ok || !permitted.ok) {
    throw new Error(`The management API did not create vhost ${vhost}.`);
  }
}

/**
 * Waits until the broker reports an exact number of open connections on a virtual host. The
 * management API refreshes its connection list every few seconds, so it retries.
 *
 * @param managementUrl - The URL from `inject('managementUrl')`.
 * @param vhost - The virtual host to count on.
 * @param expectedCount - The number of connections to wait for.
 * @param timeoutMs - How long to wait for it.
 * @returns The last count the broker reported.
 */
export async function waitForConnectionCount(
  managementUrl: string,
  vhost: string,
  expectedCount: number,
  timeoutMs: number = CONNECTION_COUNT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = -1;
  while (count !== expectedCount && Date.now() < deadline) {
    const response = await fetch(
      `${managementUrl}/api/vhosts/${encodeURIComponent(vhost)}/connections`,
      { headers: { authorization: buildManagementAuthorization() } },
    );
    count = response.ok ? z.array(z.unknown()).parse(await response.json()).length : -1;
    if (count !== expectedCount) {
      await sleep(MANAGEMENT_POLL_INTERVAL_MS);
    }
  }
  return count;
}
