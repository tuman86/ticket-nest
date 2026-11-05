// The `/relay` entry of the package: the outbox relay and the pieces a service wires into it.
export { AmqpEventPublisher, type AmqpEventPublisherDependencies } from './amqp-event-publisher';
export { calculateBackoffMs } from './calculate-backoff';
export { FencedOutboxRelayStore } from './fenced-outbox-relay-store';
export {
  type BatchResult,
  OutboxBatchProcessor,
  type OutboxBatchProcessorDependencies,
} from './outbox-batch-processor';
export { OutboxRelay, type OutboxRelayDependencies } from './outbox-relay';
export { InvalidBrokerUrlError } from './invalid-broker-url.error';
export { MathRandomSource, type RandomSource } from './random-source';
export {
  AMQP_CLOSE_TIMEOUT_MS,
  AMQP_CONNECT_TIMEOUT_MS,
  AMQP_HEARTBEAT_SECONDS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BACKOFF_MIN_MS,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  PUBLISH_CONFIRM_TIMEOUT_MS,
  RELAY_STOP_WAIT_MS,
  UNROUTED_QUEUE_MAX_LENGTH,
  UNROUTED_QUEUE_MESSAGE_TTL_MS,
} from './relay-constants';
export { sleepUnlessAborted, type Sleep } from './sleep';
export {
  TopologyDeclarationError,
  type TopologyDeclarationErrorDetails,
} from './topology-declaration.error';
