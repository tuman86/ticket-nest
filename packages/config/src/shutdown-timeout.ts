import { z } from 'zod';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;

/**
 * `SHUTDOWN_TIMEOUT_MS`: how long in-flight requests may take to finish after SIGTERM before the
 * process exits anyway. 1 second to 2 minutes, default 10 seconds.
 */
export const shutdownTimeoutMsSchema = z.coerce
  .number()
  .int()
  .min(MIN_SHUTDOWN_TIMEOUT_MS)
  .max(MAX_SHUTDOWN_TIMEOUT_MS)
  .default(DEFAULT_SHUTDOWN_TIMEOUT_MS);
