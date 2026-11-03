import { z } from 'zod';

/** After a refresh token is rotated, a replay within this long is a retry, not theft. */
export const REFRESH_REUSE_GRACE_DEFAULT_MS = 10_000;

/** The largest grace window that can be configured. A longer one would shield a thief. */
export const REFRESH_REUSE_GRACE_MAX_MS = 30_000;

/**
 * `REFRESH_REUSE_GRACE_MS`: milliseconds, 0 to 30 000, default 10 000. `0` switches the grace
 * window off, so any replay of a rotated token counts as reuse.
 */
export const refreshReuseGraceMsSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(REFRESH_REUSE_GRACE_MAX_MS)
  .default(REFRESH_REUSE_GRACE_DEFAULT_MS);
