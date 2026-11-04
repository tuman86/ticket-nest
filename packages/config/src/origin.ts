import { z } from 'zod';

/**
 * @param value - Text to check.
 * @returns True when it is exactly a URL origin (scheme, host, optional port; no path or query).
 */
function isOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}

/**
 * @param value - Text to check.
 * @returns True when it is an origin that uses `http` or `https`.
 */
function isHttpOrigin(value: string): boolean {
  return isOrigin(value) && /^https?:$/.test(new URL(value).protocol);
}

/**
 * A single `http`/`https` origin such as `http://localhost:4001`, for the base URL of another
 * service. A path or trailing slash is refused, so a request path is never appended to a prefix
 * by accident.
 */
export const httpOriginSchema = z
  .string()
  .refine(isHttpOrigin, 'must be an http(s) origin such as http://localhost:4001');

/** `https://a.example, https://b.example` -> list. Empty or unset means no origin is allowed. */
export const originListSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(z.array(z.string().refine(isOrigin, 'must be an origin such as https://example.com')));
