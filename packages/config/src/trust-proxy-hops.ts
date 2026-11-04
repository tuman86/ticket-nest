import { z } from 'zod';

const MAX_TRUST_PROXY_HOPS = 10;

/**
 * `TRUST_PROXY_HOPS`: how many reverse proxies in front of the service have their
 * `X-Forwarded-For` trusted for the client IP. `0` (default) uses the socket address, so a client
 * that reaches the service directly cannot choose its own IP. Express reads it through
 * `request.ip`; no code reads the header itself.
 */
export const trustProxyHopsSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_TRUST_PROXY_HOPS)
  .default(0);
