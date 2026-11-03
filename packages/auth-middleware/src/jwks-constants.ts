/**
 * How long fetched keys are used without asking again. Equals the `max-age` auth-service serves
 * the key set with, and is the ceiling ADR-0013 sets for any verifier's cache.
 */
export const JWKS_CACHE_TTL_MS = 300 * 1000;

/**
 * Shortest time between two fetches, whatever triggered them. A token with an unknown `kid` is
 * the one input an attacker controls, so without this a flood of forged ids would become a flood
 * of requests to auth-service. Also what one failed fetch costs before the next try.
 */
export const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;

/**
 * How long after its last successful fetch a key set is still used when auth-service cannot be
 * reached. It keeps verification working through a short auth-service outage, which is the point
 * of stateless verification. Past it, a leaked key that was already rotated out would stay trusted
 * for too long, so verification answers 503 instead.
 */
export const JWKS_STALE_IF_ERROR_MS = 60 * 60 * 1000;

/** A fetch that takes longer than this counts as failed. */
export const JWKS_FETCH_TIMEOUT_MS = 2 * 1000;

/** Largest key set body read. The real one is a few hundred bytes (at most 4 keys). */
export const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;

/** The `Retry-After` of a 503 caused by an unavailable key set: one cooldown. */
export const JWKS_UNAVAILABLE_RETRY_AFTER_SECONDS = JWKS_REFETCH_COOLDOWN_MS / 1000;
