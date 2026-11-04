import { IP_SCOPE, USER_SCOPE, type RateLimitPolicy } from '@ticketnest/rate-limit';

import {
  GATEWAY_IP_LIMIT,
  GATEWAY_USER_LIMIT,
  GATEWAY_WINDOW_MS,
} from './gateway-rate-limit-constants';

/**
 * Fails open: the services behind the gateway keep their own limits, and login and register fail
 * closed inside auth-service, so a Redis outage must not take the whole API down.
 */
export const GATEWAY_IP_POLICY: RateLimitPolicy = {
  name: 'gateway-ip',
  failureMode: 'fail-open',
  rules: [{ scope: IP_SCOPE, limit: GATEWAY_IP_LIMIT, windowMs: GATEWAY_WINDOW_MS }],
};

export const GATEWAY_USER_POLICY: RateLimitPolicy = {
  name: 'gateway-user',
  failureMode: 'fail-open',
  rules: [{ scope: USER_SCOPE, limit: GATEWAY_USER_LIMIT, windowMs: GATEWAY_WINDOW_MS }],
};
