import { createHmac } from 'node:crypto';

import { InternalServerError } from '@ticketnest/errors';

import { PLAINTEXT_SCOPES, RATE_LIMIT_KEY_PREFIX } from './rate-limit-constants';

export interface RateLimitKeyInput {
  /** Policy the counter belongs to, so each endpoint or layer counts on its own. */
  readonly policyName: string;
  readonly scope: string;
  /** The raw value: an IP, a user id, a normalized email or a refresh token. */
  readonly identifier: string;
  /** Secret that keeps a leaked Redis from being matched against known emails or tokens. */
  readonly pepper?: string | undefined;
}

/**
 * Builds the Redis key of one counter. An IP or a user id (see `PLAINTEXT_SCOPES`) is stored as
 * is, since it is the key's whole point and is what an operator would look up. Any other
 * identifier, such as an email or a refresh token, is replaced by an HMAC, so Redis never holds
 * it in plaintext and a dump cannot be matched against a list of emails.
 *
 * @param input - The policy, the scope, the raw identifier and the pepper.
 * @returns A key such as `rl:v1:login:email:<64 hex characters>`.
 * @throws InternalServerError when the scope is hashed and no pepper was configured.
 */
export function buildRateLimitKey(input: RateLimitKeyInput): string {
  const { policyName, scope, identifier, pepper } = input;
  const prefix = `${RATE_LIMIT_KEY_PREFIX}:${policyName}:${scope}`;
  if (PLAINTEXT_SCOPES.has(scope)) {
    return `${prefix}:${identifier}`;
  }
  if (pepper === undefined) {
    throw new InternalServerError({
      detail: `The rate-limit scope "${scope}" is hashed but no key pepper was configured.`,
    });
  }
  // The scope is part of the hashed text, so an email and a token that read the same stay apart.
  const digest = createHmac('sha256', pepper).update(`${scope}:${identifier}`).digest('hex');
  return `${prefix}:${digest}`;
}
