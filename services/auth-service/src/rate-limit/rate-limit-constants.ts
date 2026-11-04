const MINUTE_MS = 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * MINUTE_MS;
const ONE_HOUR_MS = 60 * MINUTE_MS;

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
