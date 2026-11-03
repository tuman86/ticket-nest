import { type RateLimitDecision, type RateLimiter } from '@/rate-limit/rate-limiter';

interface Window {
  count: number;
  resetsAtMs: number;
}

/**
 * A fixed-window limiter in memory, with the same rules as the Redis one: the first hit opens a
 * window of `windowMs`, every hit counts (denied ones too) and the counter is gone once the window
 * ends. Tests drive time through `now`, and can make it fail or hang like a broken Redis.
 */
export class InMemoryRateLimiter implements RateLimiter {
  /** Every key `consume` was called with, in order, so tests can see which counters were touched. */
  readonly consumedKeys: string[] = [];

  /** When set, `consume` rejects with it. Models an unreachable Redis. */
  failure: Error | undefined;

  /** When true, `consume` never settles. Models a Redis that accepts the command but never answers. */
  isHanging = false;

  private readonly windows = new Map<string, Window>();

  /**
   * Creates an empty limiter that reads time from `now`, so a test can jump past a window.
   *
   * @param now - The clock the windows follow. Defaults to real time.
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Counts one request against a key.
   *
   * @param key - The counter to increment.
   * @param limit - Requests allowed per window.
   * @param windowMs - Window length in milliseconds.
   * @returns Whether the request is allowed and when the window ends.
   * @throws Error when `failure` is set.
   */
  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    this.consumedKeys.push(key);
    if (this.isHanging) {
      return new Promise<RateLimitDecision>(() => undefined);
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const nowMs = this.now().getTime();
    const existing = this.windows.get(key);
    const window =
      existing !== undefined && existing.resetsAtMs > nowMs
        ? existing
        : { count: 0, resetsAtMs: nowMs + windowMs };
    window.count += 1;
    this.windows.set(key, window);
    return Promise.resolve({
      isAllowed: window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      retryAfterMs: window.resetsAtMs - nowMs,
    });
  }
}
