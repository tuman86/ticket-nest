/** Both gateway limits count over one minute, long enough to smooth bursts, short enough to recover fast. */
export const GATEWAY_WINDOW_MS = 60 * 1000;

/**
 * Requests one client IP may send per window across every route, before the token is checked.
 * Starting value, to be tuned: it must leave room for several users behind one office or mobile
 * carrier address. Auth-service's own per-email limits stay the brute-force defence for login.
 */
export const GATEWAY_IP_LIMIT = 300;

/** Requests one signed-in user may send per window, counted after the token is verified. */
export const GATEWAY_USER_LIMIT = 120;
