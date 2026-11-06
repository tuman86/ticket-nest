import { type PermissionKey } from '@ticketnest/contracts';
import { ForbiddenError } from '@ticketnest/errors';

import { type AccessRefusalReason } from './access-scope';

/**
 * Builds the sentence the response carries. It names the keys the route accepts, which the public
 * spec lists anyway, and nothing about the caller.
 *
 * @param requiredKeys - The keys the route accepts, at least one.
 * @returns The detail text.
 */
function describeRequiredKeys(requiredKeys: readonly PermissionKey[]): string {
  const quotedKeys = requiredKeys.map((key) => `\`${key}\``);
  return quotedKeys.length === 1
    ? `Missing permission ${quotedKeys.join('')}.`
    : `Missing one of the permissions ${quotedKeys.join(', ')}.`;
}

/**
 * 403: the caller is signed in but may not use this route. Every cause (no matching key, a
 * `:tenant` key on a token without a tenant, a platform-only key on a tenant token) answers the
 * same detail, which names the keys the route accepts and never the caller's own permissions, its
 * role or the rule that applied. The reason stays on the error for the log (ADR-0025).
 */
export class InsufficientPermissionError extends ForbiddenError {
  /**
   * @param requiredKeys - The keys the route accepts, in route order.
   * @param reason - Why the caller was refused. Logged internally, never in the response.
   * @param options - Optional cause.
   */
  constructor(
    requiredKeys: readonly PermissionKey[],
    readonly reason: AccessRefusalReason,
    options: { readonly cause?: unknown } = {},
  ) {
    super({ detail: describeRequiredKeys(requiredKeys), ...options });
  }
}
