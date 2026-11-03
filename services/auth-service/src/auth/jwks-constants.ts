/** Where the public key set is served. Unversioned by convention (RFC 8615), so not under `/v1`. */
export const JWKS_PATH = '/.well-known/jwks.json';

/** Registered media type of a JWK Set (RFC 7517 section 8.5). */
export const JWKS_CONTENT_TYPE = 'application/jwk-set+json';

/**
 * How long a verifier may reuse a fetched key set. It also sets the rotation rule: a new key must
 * be published at least this long before it starts signing (docs/runbooks/jwt-key-rotation.md).
 */
export const JWKS_CACHE_MAX_AGE_SECONDS = 300;

/** The `Cache-Control` value of the key set response. */
export const JWKS_CACHE_CONTROL = `public, max-age=${String(JWKS_CACHE_MAX_AGE_SECONDS)}`;

/** The only methods the key set path accepts. `HEAD` is answered by the `GET` handler. */
export const JWKS_ALLOWED_METHODS = ['GET', 'HEAD'] as const;
