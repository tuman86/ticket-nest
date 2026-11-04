/** Start of every Redis key. Bump the version to drop all counters when the key format changes. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:v1';

/** Stands in for the client IP when Express cannot tell, so a missing IP never skips the IP rule. */
export const UNKNOWN_IP_IDENTIFIER = 'unknown';

/** Longest the limiter may take before it counts as down. Keeps a hung Redis from stalling a request. */
export const RATE_LIMIT_TIMEOUT_MS = 500;

/** `Retry-After` of the 503 sent when the limiter is down and the policy fails closed. */
export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export const MILLISECONDS_PER_SECOND = 1000;

/** `Retry-After` is never 0: a client told to retry at once would hit the same limit again. */
export const MINIMUM_RETRY_AFTER_SECONDS = 1;

/** The scope of a rule that counts by client IP. */
export const IP_SCOPE = 'ip';

/** The scope of a rule that counts by authenticated user id (the token's `sub`). */
export const USER_SCOPE = 'user';

/**
 * Scopes whose identifier is stored in the Redis key as is: an IP is what an operator looks up,
 * and a user id is an opaque UUID. Every other scope (an email, a refresh token) is stored as an
 * HMAC, so a new scope is hashed unless it is added here on purpose.
 */
export const PLAINTEXT_SCOPES: ReadonlySet<string> = new Set([IP_SCOPE, USER_SCOPE]);
