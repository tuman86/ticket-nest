import { z } from 'zod';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;

const BROKER_URL_REQUIRED_MESSAGE = 'required while OUTBOX_RELAY_ENABLED is true';

/**
 * The variables of a service that runs the outbox relay (ADR-0007). A service spreads this into
 * `baseConfigSchema.extend({...})` and calls `requireBrokerUrlWhenRelayEnabled` from its
 * `superRefine`.
 *
 * - `RABBITMQ_URL`: `amqp` or `amqps`, credentials and the vhost in the path. It holds a password,
 *   so a failure names the variable and never prints the value.
 * - `OUTBOX_RELAY_ENABLED`: default `true`. Accepts the `z.stringbool` spellings.
 * - `OUTBOX_RELAY_POLL_INTERVAL_MS`: wait after a batch that was not full, 100 to 60 000, default 1 000.
 * - `OUTBOX_RELAY_BATCH_SIZE`: most rows one batch claims, 1 to 500, default 50.
 */
export const outboxRelayConfigShape = {
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }).optional(),
  OUTBOX_RELAY_ENABLED: z.stringbool().default(true),
  OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(MIN_POLL_INTERVAL_MS)
    .max(MAX_POLL_INTERVAL_MS)
    .default(DEFAULT_POLL_INTERVAL_MS),
  OUTBOX_RELAY_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(MIN_BATCH_SIZE)
    .max(MAX_BATCH_SIZE)
    .default(DEFAULT_BATCH_SIZE),
};

/**
 * Refuses a configuration that enables the relay without a broker, so a deployment that forgot
 * `RABBITMQ_URL` stops at startup instead of silently never publishing (ADR-0007).
 *
 * @param config - The parsed configuration, at least the relay variables.
 * @param context - The refinement context of the service's schema, which receives the issue.
 */
export function requireBrokerUrlWhenRelayEnabled(
  config: {
    readonly OUTBOX_RELAY_ENABLED: boolean;
    readonly RABBITMQ_URL?: string | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  if (config.OUTBOX_RELAY_ENABLED && config.RABBITMQ_URL === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['RABBITMQ_URL'],
      message: BROKER_URL_REQUIRED_MESSAGE,
    });
  }
}
