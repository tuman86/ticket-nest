/** Access tokens live 10 minutes. Never issue a longer-lived one (`.claude/rules/security.md`). */
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;

/** A refresh token expires after 7 days without use. */
export const REFRESH_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A session (token family) never outlives 30 days from the password login. Used by refresh. */
export const REFRESH_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Refresh tokens carry 256 bits of randomness. */
export const REFRESH_TOKEN_BYTES = 32;

/** Longest `User-Agent` stored (the column is `VARCHAR(512)`). */
export const USER_AGENT_MAX_LENGTH = 512;

/** Longest IP text stored: an IPv6 address with an IPv4 tail is 45 characters. */
export const IP_MAX_LENGTH = 45;
