const MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS;
const ONE_HOUR_MS = 60 * MINUTE_MS;

/** Start of every Redis key. Bump the version to drop all counters when the key format changes. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:v1';

/** Stands in for the client IP when Express cannot tell, so a missing IP never skips the IP rule. */
export const UNKNOWN_IP_IDENTIFIER = 'unknown';

/** Longest the limiter may take before it counts as down. Keeps a hung Redis from stalling login. */
export const RATE_LIMIT_TIMEOUT_MS = 500;

/** `Retry-After` of the 503 sent when the limiter is down and the policy fails closed. */
export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

export const MILLISECONDS_PER_SECOND = 1000;

/** `Retry-After` is never 0: a client told to retry at once would hit the same limit again. */
export const MINIMUM_RETRY_AFTER_SECONDS = 1;

/** Registration is the enumeration oracle (409 for a taken email), so its limits are the tightest. */
export const REGISTER_WINDOW_MS = ONE_HOUR_MS;
export const REGISTER_IP_LIMIT = 5;
export const REGISTER_EMAIL_LIMIT = 3;

/** Each login attempt costs an argon2id verification, and the endpoint is the stuffing target. */
export const LOGIN_WINDOW_MS = FIFTEEN_MINUTES_MS;
export const LOGIN_IP_LIMIT = 20;
export const LOGIN_EMAIL_LIMIT = 10;

/** Clients refresh about every 8 minutes per tab, so a shared office address needs headroom. */
export const REFRESH_WINDOW_MS = FIFTEEN_MINUTES_MS;
export const REFRESH_IP_LIMIT = 60;
export const REFRESH_TOKEN_LIMIT = 20;

/** Logout always answers 204, so it is no oracle, but it writes to the database. */
export const LOGOUT_WINDOW_MS = FIFTEEN_MINUTES_MS;
export const LOGOUT_IP_LIMIT = 60;
