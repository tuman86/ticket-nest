import { PLAINTEXT_SCOPES } from '@ticketnest/rate-limit';
import { describe, expect, it } from 'vitest';

import {
  GATEWAY_IP_LIMIT,
  GATEWAY_USER_LIMIT,
  GATEWAY_WINDOW_MS,
} from '@/rate-limit/gateway-rate-limit-constants';
import { GATEWAY_IP_POLICY, GATEWAY_USER_POLICY } from '@/rate-limit/gateway-rate-limit-policies';

describe('gateway rate limit policies', () => {
  it('counts a client IP per minute and fails open', () => {
    expect(GATEWAY_IP_POLICY).toEqual({
      name: 'gateway-ip',
      failureMode: 'fail-open',
      rules: [{ scope: 'ip', limit: 300, windowMs: 60_000 }],
    });
  });

  it('counts a signed-in user per minute and fails open', () => {
    expect(GATEWAY_USER_POLICY).toEqual({
      name: 'gateway-user',
      failureMode: 'fail-open',
      rules: [{ scope: 'user', limit: 120, windowMs: 60_000 }],
    });
  });

  it('keeps the two policies apart in Redis and the user limit below the IP limit', () => {
    expect(GATEWAY_IP_POLICY.name).not.toBe(GATEWAY_USER_POLICY.name);
    expect(GATEWAY_USER_LIMIT).toBeLessThan(GATEWAY_IP_LIMIT);
    expect(GATEWAY_WINDOW_MS).toBe(60_000);
  });

  it('uses plaintext scopes only, because the gateway has no key pepper to hash with', () => {
    for (const policy of [GATEWAY_IP_POLICY, GATEWAY_USER_POLICY]) {
      for (const rule of policy.rules) {
        expect(PLAINTEXT_SCOPES.has(rule.scope), `${policy.name} uses scope ${rule.scope}`).toBe(
          true,
        );
      }
    }
  });
});
