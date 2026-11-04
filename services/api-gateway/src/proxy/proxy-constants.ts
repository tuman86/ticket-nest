/** How long the gateway waits for an upstream to accept a connection. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 2_000;

/** How long the gateway waits for an upstream to start answering (time to the response headers). */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000;

/** Longest pause between two chunks of an upstream response body. */
export const UPSTREAM_BODY_TIMEOUT_MS = 30_000;

/** Connections the gateway may hold open to one upstream per replica. */
export const UPSTREAM_MAX_CONNECTIONS = 50;

/** A safe request (GET, HEAD) is tried this many times in total when the upstream is unreachable. */
export const RETRY_MAX_ATTEMPTS = 2;

/** A request that is not retried is tried once. */
export const SINGLE_ATTEMPT = 1;

/** The pause before a retry is this long plus up to `RETRY_JITTER_MS` of random jitter. */
export const RETRY_BASE_DELAY_MS = 50;
export const RETRY_JITTER_MS = 100;

/** This many failures in a row open an upstream's circuit. */
export const CIRCUIT_FAILURE_THRESHOLD = 5;

/** An open circuit refuses requests this long, then lets one trial request through. */
export const CIRCUIT_OPEN_MS = 10_000;

/** Upstream statuses that count as the upstream being down. A plain 500 is one endpoint's bug. */
export const UPSTREAM_DOWN_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export const MILLISECONDS_PER_SECOND = 1_000;
