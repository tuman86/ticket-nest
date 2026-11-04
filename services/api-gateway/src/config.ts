import {
  baseConfigSchema,
  httpOriginSchema,
  originListSchema,
  shutdownTimeoutMsSchema,
  trustProxyHopsSchema,
} from '@ticketnest/config';
import { z } from 'zod';

export const SERVICE_NAME = 'api-gateway';

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;
const MIN_MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_MAX_REQUEST_BODY_BYTES = 10 * 1_048_576;

const HTTPS_PREFIX = 'https://';
const SERVICE_URL_NAMES = ['AUTH_SERVICE_URL', 'CATALOG_SERVICE_URL'] as const;

export const gatewayConfigSchema = baseConfigSchema
  .extend({
    /** Only the rate limiter uses Redis. The gateway keeps no data of its own. */
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    /** The `iss` claim verifiers must require. Must match auth-service's `JWT_ISSUER`. */
    JWT_ISSUER: z.string().min(1),
    /** The `aud` claim verifiers must require. Must match auth-service's `JWT_AUDIENCE`. */
    JWT_AUDIENCE: z.string().min(1),
    /** Base URL of auth-service: where requests go, and where the JWKS key set is fetched from. */
    AUTH_SERVICE_URL: httpOriginSchema,
    CATALOG_SERVICE_URL: httpOriginSchema,
    /**
     * Reverse proxies in front of the gateway whose `X-Forwarded-For` is trusted for the client IP.
     * 0 (default) uses the socket address; 1 behind an ALB. The services behind the gateway keep 1.
     */
    TRUST_PROXY_HOPS: trustProxyHopsSchema,
    /** Browser origins allowed by CORS (the `web` and `console` apps). Empty denies all. */
    CORS_ORIGINS: originListSchema,
    /** Largest request body forwarded. The gateway streams bodies, so this is a byte count. */
    MAX_REQUEST_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(MIN_MAX_REQUEST_BODY_BYTES)
      .max(MAX_MAX_REQUEST_BODY_BYTES)
      .default(DEFAULT_MAX_REQUEST_BODY_BYTES),
    SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMsSchema,
    /**
     * Lets production use plain `http://` service URLs. By default production needs `https://`,
     * because the JWKS fetch decides which keys are trusted and every forwarded request carries the
     * caller's token. Set it only when the network between the gateway and the services is private
     * (for example the compose network or a service mesh).
     */
    ALLOW_INSECURE_UPSTREAMS: z.stringbool().default(false),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV !== 'production' || config.ALLOW_INSECURE_UPSTREAMS) {
      return;
    }
    for (const name of SERVICE_URL_NAMES) {
      if (!config[name].startsWith(HTTPS_PREFIX)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'must start with https:// in production (or set ALLOW_INSECURE_UPSTREAMS=true)',
        });
      }
    }
  });

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
