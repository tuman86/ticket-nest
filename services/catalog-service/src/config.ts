import {
  baseConfigSchema,
  jsonBodyLimitSchema,
  shutdownTimeoutMsSchema,
  trustProxyHopsSchema,
} from '@ticketnest/config';
import { z } from 'zod';

export const SERVICE_NAME = 'catalog-service';

export const catalogConfigSchema = baseConfigSchema.extend({
  /** The service's own database. Holds the login password, so it is never logged. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  JSON_BODY_LIMIT: jsonBodyLimitSchema,
  SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMsSchema,
  /**
   * Reverse proxies in front of the service whose `X-Forwarded-For` is trusted for the client IP.
   * 0 (default) uses the socket address, so a client cannot spoof its IP; 1 behind the gateway.
   */
  TRUST_PROXY_HOPS: trustProxyHopsSchema,
});

export type CatalogConfig = z.infer<typeof catalogConfigSchema>;
