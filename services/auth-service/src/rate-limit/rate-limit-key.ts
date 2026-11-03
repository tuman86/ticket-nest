import { createHmac } from 'node:crypto';

import { RATE_LIMIT_KEY_PREFIX } from './rate-limit-constants';
import { type RateLimitPolicyName, type RateLimitScope } from './rate-limit-policies';

export interface RateLimitKeyInput {
  /** Endpoint the counter belongs to, so each endpoint counts on its own. */
  readonly policyName: RateLimitPolicyName;
  readonly scope: RateLimitScope;
  /** The raw value: an IP, a normalized email or a refresh token. */
  readonly identifier: string;
  /** Secret that keeps a leaked Redis from being matched against known emails or tokens. */
  readonly pepper: string;
}

/**
 * Builds the Redis key of one counter. An IP is stored as is, since it is the key's whole point
 * and is what an operator would look up. An email or a refresh token is replaced by an HMAC, so
 * Redis never holds either in plaintext and a dump cannot be matched against a list of emails.
 *
 * @param input - The endpoint, the scope, the raw identifier and the pepper.
 * @returns A key such as `rl:v1:login:email:<64 hex characters>`.
 */
export function buildRateLimitKey(input: RateLimitKeyInput): string {
  const { policyName, scope, identifier, pepper } = input;
  const prefix = `${RATE_LIMIT_KEY_PREFIX}:${policyName}:${scope}`;
  if (scope === 'ip') {
    return `${prefix}:${identifier}`;
  }
  // The scope is part of the hashed text, so an email and a token that read the same stay apart.
  const digest = createHmac('sha256', pepper).update(`${scope}:${identifier}`).digest('hex');
  return `${prefix}:${digest}`;
}
