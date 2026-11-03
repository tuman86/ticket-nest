import { createPrivateKey, type KeyObject } from 'node:crypto';

import { baseConfigSchema, refreshReuseGraceMsSchema } from '@ticketnest/config';
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

const INVALID_PRIVATE_KEY_MESSAGE = 'must be a base64-encoded PKCS#8 PEM of an Ed25519 private key';

/**
 * `JWT_PRIVATE_KEY`: base64 of the PKCS#8 PEM text (base64 avoids newline trouble in env files).
 * Parsed once at startup into a key object. A bad value is reported by name only: the message
 * is fixed text, so the key material never reaches an error or a log.
 */
const ed25519PrivateKeySchema = z
  .string()
  .min(1)
  .transform((encoded, context): KeyObject => {
    try {
      const key = createPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'));
      if (key.asymmetricKeyType === 'ed25519') {
        return key;
      }
    } catch {
      // Fall through to the single generic issue below; the parser's message may echo the input.
    }
    context.addIssue({ code: 'custom', message: INVALID_PRIVATE_KEY_MESSAGE });
    return z.NEVER;
  });

export const authConfigSchema = baseConfigSchema.extend({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  /** Access-token signing key. Only auth-service holds it; verifiers get the public key. */
  JWT_PRIVATE_KEY: ed25519PrivateKeySchema,
  /** Goes in the `kid` header so verifiers can pick the matching public key. */
  JWT_KEY_ID: z.string().min(1),
  /** The `iss` claim verifiers must require. */
  JWT_ISSUER: z.string().min(1),
  /** The `aud` claim verifiers must require. */
  JWT_AUDIENCE: z.string().min(1),
  /** A replay of a just-rotated refresh token within this long is a retry, not theft. */
  REFRESH_REUSE_GRACE_MS: refreshReuseGraceMsSchema,
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
