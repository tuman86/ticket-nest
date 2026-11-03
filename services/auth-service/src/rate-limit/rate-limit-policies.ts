import {
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_WINDOW_MS,
  LOGOUT_IP_LIMIT,
  LOGOUT_WINDOW_MS,
  REFRESH_IP_LIMIT,
  REFRESH_TOKEN_LIMIT,
  REFRESH_WINDOW_MS,
  REGISTER_EMAIL_LIMIT,
  REGISTER_IP_LIMIT,
  REGISTER_WINDOW_MS,
} from './rate-limit-constants';

/** What a rule counts requests by. */
export type RateLimitScope = 'ip' | 'email' | 'refresh-token';

/** What to do when the limiter itself is down: refuse the request, or let it through. */
export type RateLimitFailureMode = 'fail-closed' | 'fail-open';

export type RateLimitPolicyName = 'register' | 'login' | 'refresh' | 'logout';

/** One counter: at most `limit` requests per `windowMs` for each value of `scope`. */
export interface RateLimitRule {
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowMs: number;
}

/** The rules of one endpoint. A request is refused when any rule is over its limit. */
export interface RateLimitPolicy {
  readonly name: RateLimitPolicyName;
  /** Checked in order, and checking stops at the first denial. Put the IP rule first. */
  readonly rules: readonly RateLimitRule[];
  readonly failureMode: RateLimitFailureMode;
}

export const REGISTER_POLICY: RateLimitPolicy = {
  name: 'register',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: REGISTER_IP_LIMIT, windowMs: REGISTER_WINDOW_MS },
    { scope: 'email', limit: REGISTER_EMAIL_LIMIT, windowMs: REGISTER_WINDOW_MS },
  ],
};

export const LOGIN_POLICY: RateLimitPolicy = {
  name: 'login',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: LOGIN_IP_LIMIT, windowMs: LOGIN_WINDOW_MS },
    { scope: 'email', limit: LOGIN_EMAIL_LIMIT, windowMs: LOGIN_WINDOW_MS },
  ],
};

/** Fails open: a valid refresh token is a secret, and failing closed would sign everyone out. */
export const REFRESH_POLICY: RateLimitPolicy = {
  name: 'refresh',
  failureMode: 'fail-open',
  rules: [
    { scope: 'ip', limit: REFRESH_IP_LIMIT, windowMs: REFRESH_WINDOW_MS },
    { scope: 'refresh-token', limit: REFRESH_TOKEN_LIMIT, windowMs: REFRESH_WINDOW_MS },
  ],
};

export const LOGOUT_POLICY: RateLimitPolicy = {
  name: 'logout',
  failureMode: 'fail-open',
  rules: [{ scope: 'ip', limit: LOGOUT_IP_LIMIT, windowMs: LOGOUT_WINDOW_MS }],
};
