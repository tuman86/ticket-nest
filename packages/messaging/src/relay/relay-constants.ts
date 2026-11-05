/** How long the broker may take to confirm one publish before that row counts as failed (ADR-0007). */
export const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;

/** How long a claim keeps its rows. It must stay above `PUBLISH_CONFIRM_TIMEOUT_MS`. */
export const CLAIM_LEASE_MS = 60_000;

/** How long `stop()` waits for the batch in flight. It must stay below `SHUTDOWN_TIMEOUT_MS`. */
export const RELAY_STOP_WAIT_MS = 5_000;

/** The failure that reaches this count makes the row terminal (`failed_at`). */
export const MAX_ATTEMPTS = 10;

/** Upper bound of the retry delay after the first failure; it doubles with every failure. */
export const BACKOFF_BASE_MS = 1_000;

/** The retry delay never grows past this. */
export const BACKOFF_CAP_MS = 5 * 60 * 1_000;

/** The retry delay never falls below this, so a failed row is never retried at once. */
export const BACKOFF_MIN_MS = 100;

/**
 * The AMQP heartbeat the publisher asks for, in seconds. amqplib notices a silent link between two
 * and three intervals after it goes quiet, so a half-open connection closes within three times
 * this, which must stay inside `PUBLISH_CONFIRM_TIMEOUT_MS` (ADR-0007). Without it a dead link
 * would end every publish as a charged `confirm_timeout`.
 */
export const AMQP_HEARTBEAT_SECONDS = 3;

/** How long opening the TCP connection to the broker may take before it counts as unreachable. */
export const AMQP_CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long closing the channel, and then the connection, may each take. Closing never throws and
 * gives up after this, so shutdown cannot hang on a broker that no longer answers.
 */
export const AMQP_CLOSE_TIMEOUT_MS = 2_000;

/** How long the catch-all queue keeps a message nobody consumed (ADR-0005): seven days. */
export const UNROUTED_QUEUE_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The most messages the catch-all queue holds; the oldest is dropped beyond it (ADR-0005). */
export const UNROUTED_QUEUE_MAX_LENGTH = 100_000;
