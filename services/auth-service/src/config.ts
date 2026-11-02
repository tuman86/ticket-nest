import { baseConfigSchema } from '@ticketnest/config';
import { z } from 'zod';

export const SERVICE_NAME = 'auth-service';

const DEFAULT_JSON_BODY_LIMIT = '100kb';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;
const BODY_LIMIT_PATTERN = /^\d+(b|kb|mb)$/i;

function isOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}

/** `https://a.example, https://b.example` -> list. Empty means no origin is allowed. */
const originListSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(z.array(z.string().refine(isOrigin, 'must be an origin such as https://example.com')));

export const authConfigSchema = baseConfigSchema.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  CORS_ORIGINS: originListSchema,
  JSON_BODY_LIMIT: z.string().regex(BODY_LIMIT_PATTERN).default(DEFAULT_JSON_BODY_LIMIT),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_SHUTDOWN_TIMEOUT_MS)
    .max(MAX_SHUTDOWN_TIMEOUT_MS)
    .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
