/** The outcome of counting one request against one key. */
export interface RateLimitDecision {
  /** False once the key is over its limit for the current window. */
  readonly isAllowed: boolean;
  /** Requests allowed per window, echoed back for response headers. */
  readonly limit: number;
  /** Requests left in the current window, never negative. */
  readonly remaining: number;
  /** Milliseconds until the current window ends and the counter starts again. */
  readonly retryAfterMs: number;
}

/**
 * Counts requests per key in fixed windows. The one interface between the rate-limit rules and
 * the store that holds the counters (Redis in production, memory in tests).
 */
export interface RateLimiter {
  /**
   * Counts one request against a key. Every call counts, denied ones included, and a denied call
   * does not move the end of the window.
   *
   * @param key - The counter to increment.
   * @param limit - Requests allowed per window.
   * @param windowMs - Window length in milliseconds. The first request opens the window.
   * @returns Whether the request is allowed and when the window ends.
   */
  consume: (key: string, limit: number, windowMs: number) => Promise<RateLimitDecision>;
}
