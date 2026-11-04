import { z } from 'zod';

import { UNKNOWN_IP_IDENTIFIER } from './rate-limit-constants';

/** A client IP is the only header-derived value that reaches a Redis key, so it must be an address. */
const ClientIp = z.union([z.ipv4(), z.ipv6()]);
const ZONE_ID_SEPARATOR = '%';

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
export function readClientIp(ip: string | undefined): string {
  if (ip === undefined) {
    return UNKNOWN_IP_IDENTIFIER;
  }
  const zoneStart = ip.indexOf(ZONE_ID_SEPARATOR);
  const parsed = ClientIp.safeParse(zoneStart === -1 ? ip : ip.slice(0, zoneStart));
  return parsed.success ? parsed.data : UNKNOWN_IP_IDENTIFIER;
}

/**
 * Tells whether `readClientIp` found a real address, so a caller never has to know the stand-in
 * value used when it did not.
 *
 * @param clientIp - A value returned by `readClientIp`.
 * @returns `false` for the shared unknown bucket, `true` for an address.
 */
export function isKnownClientIp(clientIp: string): boolean {
  return clientIp !== UNKNOWN_IP_IDENTIFIER;
}
