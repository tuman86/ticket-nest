import { type RateLimitPolicy } from '@/rate-limit-policy';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Fixtures shaped like auth-service's policies (IP rule first, then an account rule). */
export const REGISTER_POLICY: RateLimitPolicy = {
  name: 'register',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: 5, windowMs: ONE_HOUR_MS },
    { scope: 'email', limit: 3, windowMs: ONE_HOUR_MS },
  ],
};

export const LOGIN_POLICY: RateLimitPolicy = {
  name: 'login',
  failureMode: 'fail-closed',
  rules: [
    { scope: 'ip', limit: 20, windowMs: FIFTEEN_MINUTES_MS },
    { scope: 'email', limit: 10, windowMs: FIFTEEN_MINUTES_MS },
  ],
};

export const REFRESH_POLICY: RateLimitPolicy = {
  name: 'refresh',
  failureMode: 'fail-open',
  rules: [
    { scope: 'ip', limit: 60, windowMs: FIFTEEN_MINUTES_MS },
    { scope: 'refresh-token', limit: 20, windowMs: FIFTEEN_MINUTES_MS },
  ],
};

export const LOGOUT_POLICY: RateLimitPolicy = {
  name: 'logout',
  failureMode: 'fail-open',
  rules: [{ scope: 'ip', limit: 60, windowMs: FIFTEEN_MINUTES_MS }],
};
