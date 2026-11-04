/** What to do when the limiter itself is down: refuse the request, or let it through. */
export type RateLimitFailureMode = 'fail-closed' | 'fail-open';

/**
 * One counter: at most `limit` requests per `windowMs` for each value of `scope`. A scope names
 * what the rule counts by (`ip`, `user`, `email`...); the request supplies the value.
 */
export interface RateLimitRule {
  readonly scope: string;
  readonly limit: number;
  readonly windowMs: number;
}

/** The rules of one endpoint or one layer. A request is refused when any rule is over its limit. */
export interface RateLimitPolicy {
  /** Part of every Redis key, so each policy counts on its own. */
  readonly name: string;
  /** Checked in order, and checking stops at the first denial. Put the IP rule first. */
  readonly rules: readonly RateLimitRule[];
  readonly failureMode: RateLimitFailureMode;
}

/** The raw values of a request that rules can count by. A scope is absent when the request has none. */
export type RateLimitIdentifiers = Readonly<Partial<Record<string, string>>>;
