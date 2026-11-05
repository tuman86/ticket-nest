// The `./testing/rabbitmq` entry of the package: a throwaway RabbitMQ and the helpers to read from
// it, for the integration tests of services that publish. Kept apart from `./testing` so a unit
// test that only needs the in-memory fakes never loads Testcontainers or amqplib. Relative imports
// on purpose, because `@/` would resolve to the importing workspace.
export { startRabbitMqBroker, type RunningBroker } from './start-rabbitmq-broker';
export {
  fetchMessages,
  openTestConnection,
  sleep,
  waitForConnectionCount,
  waitForExchange,
} from './test-amqp';
