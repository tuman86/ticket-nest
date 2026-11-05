import { RabbitMQContainer } from '@testcontainers/rabbitmq';

/** Same tag as infra/docker/docker-compose.yml, so tests run against the version we deploy. */
const RABBITMQ_IMAGE = 'rabbitmq:4.3.7-management-alpine';
/** The Testcontainers module creates this user, and no other. */
const RABBITMQ_USER = 'guest';
const RABBITMQ_PASSWORD = 'guest';
const AMQP_PORT = 5672;
const MANAGEMENT_PORT = 15672;
const STARTUP_TIMEOUT_MS = 60_000;

/** A throwaway RabbitMQ broker and the handles a test needs to reach and control it. */
export interface RunningBroker {
  /** AMQP URL with credentials, on the default vhost. */
  readonly amqpUrl: string;
  /** Base URL of the management HTTP API. */
  readonly managementUrl: string;
  /** Host and mapped port of the AMQP listener, for a proxy to forward to. */
  readonly amqpHost: string;
  readonly amqpPort: number;
  /**
   * Runs a command inside the broker's container, for example `rabbitmqctl close_all_connections`.
   *
   * @param command - The program and its arguments.
   * @throws Error when the command exits with a non-zero code.
   */
  run: (command: readonly string[]) => Promise<void>;
  /** Stops and removes the container. */
  stop: () => Promise<void>;
}

/**
 * Starts a RabbitMQ container and waits until it is ready.
 *
 * @returns The running broker. The caller must `stop()` it.
 */
export async function startRabbitMqBroker(): Promise<RunningBroker> {
  const container = await new RabbitMQContainer(RABBITMQ_IMAGE)
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();

  // The module's URL has no credentials, and amqplib reads them from the URL.
  const amqpUrl = new URL(container.getAmqpUrl());
  amqpUrl.username = RABBITMQ_USER;
  amqpUrl.password = RABBITMQ_PASSWORD;

  return {
    amqpUrl: amqpUrl.toString(),
    managementUrl: `http://${container.getHost()}:${String(container.getMappedPort(MANAGEMENT_PORT))}`,
    amqpHost: container.getHost(),
    amqpPort: container.getMappedPort(AMQP_PORT),
    /**
     * @param command - The program and its arguments, run inside the container.
     * @throws Error when the command exits with a non-zero code.
     */
    async run(command) {
      const result = await container.exec([...command]);
      if (result.exitCode !== 0) {
        throw new Error(
          `${command.join(' ')} exited with ${String(result.exitCode)}: ${result.output}`,
        );
      }
    },
    /**
     * Stops and removes the container.
     */
    async stop() {
      await container.stop();
    },
  };
}
