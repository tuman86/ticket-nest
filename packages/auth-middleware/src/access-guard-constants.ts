/**
 * How old `auth_time` may be for an operation marked `x-recent-login: true` (ADR-0025). Five
 * minutes, the figure the specs and `common.yaml` state in prose; change them together.
 */
export const RECENT_LOGIN_MAX_AGE_MS = 5 * 60 * 1000;
