import { type TestProject } from 'vitest/node';

import { startRabbitMqBroker } from './start-rabbitmq-broker';

declare module 'vitest' {
  export interface ProvidedContext {
    /** AMQP URL, with credentials, of the throwaway RabbitMQ started for this test run. */
    amqpUrl: string;
    /** Base URL of that broker's management HTTP API. */
    managementUrl: string;
  }
}

/**
 * Vitest global setup: starts one RabbitMQ container and shares its URLs with the test files
 * through `inject('amqpUrl')` and `inject('managementUrl')`.
 *
 * @param project - The Vitest project that runs the integration tests.
 * @returns A teardown function that stops the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const broker = await startRabbitMqBroker();
  project.provide('amqpUrl', broker.amqpUrl);
  project.provide('managementUrl', broker.managementUrl);
  return broker.stop;
}
