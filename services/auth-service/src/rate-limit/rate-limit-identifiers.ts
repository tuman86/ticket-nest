import { z } from 'zod';

import { normalizeEmail } from '../users/normalize-email';
import { UNKNOWN_IP_IDENTIFIER } from './rate-limit-constants';
import { type RateLimitScope } from './rate-limit-policies';

/** The raw values of a request that rules can count by. A scope is absent when the request has none. */
export type RateLimitIdentifiers = Partial<Record<RateLimitScope, string>>;

/** The slice of an Express request this reads, so tests need no real request. */
export interface RateLimitRequest {
  /** The client IP Express settled on (it honours `trust proxy`). */
  readonly ip: string | undefined;
  /** The parsed JSON body. Untrusted: it is read before the endpoint validates it. */
  readonly body: unknown;
}

/** A client IP is the only header-derived value that reaches a Redis key, so it must be an address. */
const ClientIp = z.union([z.ipv4(), z.ipv6()]);
const ZONE_ID_SEPARATOR = '%';

// Each field has its own schema, so a bad email does not hide a good refresh token.
const EmailBody = z.object({ email: z.string() });
const RefreshTokenBody = z.object({ refreshToken: z.string().min(1) });

/**
 * Turns the IP Express settled on into a value that is safe to put in a key. `request.ip` comes
 * from the socket, or from `X-Forwarded-For` when proxies are trusted, so a misconfigured proxy
 * could pass any string. Anything that is not an IPv4 or IPv6 address (which also caps its length)
 * falls into the shared `unknown` bucket, so a bad value is limited more strictly, never skipped.
 *
 * @param ip - The address Express reports, if any.
 * @returns The address without its IPv6 zone id (`fe80::1%eth0` is one client whatever the
 *   interface), or `unknown` when there is none or it is not an address.
 */
function readClientIp(ip: string | undefined): string {
  if (ip === undefined) {
    return UNKNOWN_IP_IDENTIFIER;
  }
  const zoneStart = ip.indexOf(ZONE_ID_SEPARATOR);
  const parsed = ClientIp.safeParse(zoneStart === -1 ? ip : ip.slice(0, zoneStart));
  return parsed.success ? parsed.data : UNKNOWN_IP_IDENTIFIER;
}

/**
 * Reads what the limiter counts by. It runs before the endpoint's own validation, so it picks out
 * only the fields it needs and ignores everything else; a request with a malformed body still gets
 * its IP counted and then its normal 422 from the handler.
 *
 * @param request - The incoming request, after the JSON body parser.
 * @returns The IP (a shared `unknown` bucket when there is none or it is invalid), plus the email, normalized the
 *   way accounts are stored, and the refresh token, when the body has them.
 */
export function readRateLimitIdentifiers(request: RateLimitRequest): RateLimitIdentifiers {
  const identifiers: RateLimitIdentifiers = {
    ip: readClientIp(request.ip),
  };
  const email = EmailBody.safeParse(request.body);
  if (email.success) {
    const normalizedEmail = normalizeEmail(email.data.email);
    if (normalizedEmail !== '') {
      identifiers.email = normalizedEmail;
    }
  }
  const refreshToken = RefreshTokenBody.safeParse(request.body);
  if (refreshToken.success) {
    identifiers['refresh-token'] = refreshToken.data.refreshToken;
  }
  return identifiers;
}
