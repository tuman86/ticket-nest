import { type RateLimitPolicy } from '@ticketnest/rate-limit';

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

/** What an auth rule counts requests by. `ip` is stored as is; the others are hashed. */
export type RateLimitScope = 'ip' | 'email' | 'refresh-token';

export type { RateLimitPolicy };

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
