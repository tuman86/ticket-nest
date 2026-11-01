export const REDACTION_CENSOR = '[REDACTED]';

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'otp',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
] as const;

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie'] as const;

/**
 * Pino's `*` wildcard matches exactly one level, so a sensitive key is redacted at the top
 * level and one level down (`password`, `*.password`). Deeper nesting is NOT covered.
 */
export const REDACTED_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  ...SENSITIVE_HEADERS.flatMap((header) => [
    `headers["${header}"]`,
    `req.headers["${header}"]`,
    `res.headers["${header}"]`,
  ]),
];
