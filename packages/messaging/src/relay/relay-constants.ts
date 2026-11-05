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
