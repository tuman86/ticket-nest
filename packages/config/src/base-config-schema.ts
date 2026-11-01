import { z } from 'zod';

const MIN_PORT = 1;
const MAX_PORT = 65535;

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Variables every service needs. A service extends this with its own:
 * `baseConfigSchema.extend({ DATABASE_URL: z.url() })`.
 */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  PORT: z.coerce.number().int().min(MIN_PORT).max(MAX_PORT),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;
