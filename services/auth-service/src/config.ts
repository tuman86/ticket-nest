import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import {
  baseConfigSchema,
  originListSchema,
  outboxRelayConfigShape,
  refreshReuseGraceMsSchema,
  requireBrokerUrlWhenRelayEnabled,
  shutdownTimeoutMsSchema,
  trustProxyHopsSchema,
} from '@ticketnest/config';
import { z } from 'zod';

export const SERVICE_NAME = 'auth-service';

const DEFAULT_JSON_BODY_LIMIT = '100kb';
/** A pepper shorter than this is easier to guess than the emails it is meant to protect. */
const RATE_LIMIT_PEPPER_MIN_LENGTH = 32;
const BODY_LIMIT_PATTERN = /^\d+(b|kb|mb)$/i;

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

/** Most verify-only keys that may be published next to the signing key (a retiring and an upcoming one, with room to spare). */
const MAX_ADDITIONAL_PUBLIC_KEYS = 3;
const PUBLIC_KEY_PEM_HEADER = '-----BEGIN PUBLIC KEY-----';
const INVALID_PUBLIC_KEY_MESSAGE =
  'must be a base64-encoded SPKI PEM of an Ed25519 public key (a private key is not allowed here)';
const DUPLICATE_PUBLIC_KEY_MESSAGE = 'duplicates the signing key or another listed key';

/**
 * One `JWT_ADDITIONAL_PUBLIC_KEYS` entry: base64 of an SPKI PEM. The `BEGIN PUBLIC KEY` header is
 * required, so a private key pasted here by mistake is refused instead of silently reduced to its
 * public half. The message is fixed text, so key material never reaches an error or a log.
 */
const ed25519PublicKeySchema = z.string().transform((encoded, context): KeyObject => {
  try {
    const pem = Buffer.from(encoded, 'base64').toString('utf8').trim();
    if (pem.startsWith(PUBLIC_KEY_PEM_HEADER)) {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType === 'ed25519') {
        return key;
      }
    }
  } catch {
    // Fall through to the single generic issue below; the parser's message may echo the input.
  }
  context.addIssue({ code: 'custom', message: INVALID_PUBLIC_KEY_MESSAGE });
  return z.NEVER;
});

/** `JWT_ADDITIONAL_PUBLIC_KEYS`: comma-separated entries, empty by default. Base64 has no commas. */
const additionalPublicKeysSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .pipe(z.array(ed25519PublicKeySchema).max(MAX_ADDITIONAL_PUBLIC_KEYS));

/**
 * @param publicKey - An Ed25519 public key.
 * @returns Its public bytes as base64url, to compare two keys without exposing either.
 */
function identifyPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: 'jwk' }).x ?? '';
}

export const authConfigSchema = baseConfigSchema
  .extend({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    /** Access-token signing key. Only auth-service holds it; verifiers get the public key. */
    JWT_PRIVATE_KEY: ed25519PrivateKeySchema,
    /**
     * Extra public keys published in the JWKS but never used to sign: a retiring key whose tokens
     * have not all expired, or an upcoming key published ahead of its first use (rotation runbook).
     */
    JWT_ADDITIONAL_PUBLIC_KEYS: additionalPublicKeysSchema,
    /** The `iss` claim verifiers must require. */
    JWT_ISSUER: z.string().min(1),
    /** The `aud` claim verifiers must require. */
    JWT_AUDIENCE: z.string().min(1),
    /** A replay of a just-rotated refresh token within this long is a retry, not theft. */
    REFRESH_REUSE_GRACE_MS: refreshReuseGraceMsSchema,
    /**
     * Secret mixed into the rate-limit keys of emails and refresh tokens, so Redis never holds
     * either in plaintext and a dump cannot be matched against known emails. Changing it resets
     * the account counters, which is harmless.
     */
    RATE_LIMIT_KEY_PEPPER: z.string().min(RATE_LIMIT_PEPPER_MIN_LENGTH),
    /**
     * Reverse proxies in front of the service whose `X-Forwarded-For` is trusted for the client
     * IP. 0 (default) uses the socket address, so a client cannot spoof its IP; 1 behind the gateway.
     */
    TRUST_PROXY_HOPS: trustProxyHopsSchema,
    CORS_ORIGINS: originListSchema,
    JSON_BODY_LIMIT: z.string().regex(BODY_LIMIT_PATTERN).default(DEFAULT_JSON_BODY_LIMIT),
    SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMsSchema,
    /** `RABBITMQ_URL` and the `OUTBOX_RELAY_*` settings of the relay that publishes `user.registered`. */
    ...outboxRelayConfigShape,
  })
  .superRefine(requireBrokerUrlWhenRelayEnabled)
  .superRefine((config, context) => {
    // Rejects the same public key listed twice, or listed next to the signing key it belongs to.
    const seen = new Set([identifyPublicKey(createPublicKey(config.JWT_PRIVATE_KEY))]);
    config.JWT_ADDITIONAL_PUBLIC_KEYS.forEach((publicKey, index) => {
      const identity = identifyPublicKey(publicKey);
      if (seen.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['JWT_ADDITIONAL_PUBLIC_KEYS', index],
          message: DUPLICATE_PUBLIC_KEY_MESSAGE,
        });
      }
      seen.add(identity);
    });
  });

export type AuthConfig = z.infer<typeof authConfigSchema>;
