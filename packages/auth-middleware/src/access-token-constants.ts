/**
 * The only algorithm access tokens are signed with and accepted under (ADR-0013). RS256 is a
 * fallback the ADR allows, but no RSA key exists, so verifiers must not accept it.
 */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';

/** Longest `Authorization` header value read. Longer values are refused without parsing. */
export const AUTHORIZATION_HEADER_MAX_LENGTH = 8192;

/**
 * How far past `exp` a token is still accepted, to absorb clock drift between the machine that
 * signed it and the one that verifies it. Small on purpose: the access token only lives 10 minutes.
 */
export const ACCESS_TOKEN_CLOCK_TOLERANCE_MS = 5 * 1000;
