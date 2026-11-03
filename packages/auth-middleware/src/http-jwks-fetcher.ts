import { JWKS_FETCH_TIMEOUT_MS, JWKS_MAX_RESPONSE_BYTES } from './jwks-constants';
import { type JwksFetcher, type JwksFetchResult } from './jwks-fetcher';

const HTTP_NOT_MODIFIED = 304;
const ACCEPT_HEADER = 'application/jwk-set+json, application/json';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const BODY_TOO_LARGE_MESSAGE = 'The JWKS response is larger than the allowed size.';

export interface HttpJwksFetcherOptions {
  /** Where auth-service publishes the key set, for example `http://auth-service:4001/.well-known/jwks.json`. */
  readonly url: string;
  /** The HTTP client. Replaceable in tests. Defaults to the global `fetch`. */
  readonly fetchFunction?: typeof fetch;
  /** Per-request timeout. Defaults to `JWKS_FETCH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Fetches the key set over HTTP with a timeout, no redirects and a size limit. */
export class HttpJwksFetcher implements JwksFetcher {
  private readonly fetchFunction: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;

  /**
   * @param options - The key set URL and optional HTTP client and timeout.
   * @throws TypeError when the URL is not a valid `http` or `https` URL. The URL itself is left
   * out of the message because it may hold credentials.
   */
  constructor(options: HttpJwksFetcherOptions) {
    if (!URL.canParse(options.url) || !ALLOWED_PROTOCOLS.has(new URL(options.url).protocol)) {
      throw new TypeError('The JWKS URL must be a valid http or https URL.');
    }
    this.url = options.url;
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
  }

  /**
   * Sends one GET. A redirect is an error: the endpoint is internal and never redirects, so a
   * redirect means something is wrong or hostile.
   *
   * @param previousEtag - `ETag` of the key set already held, sent as `If-None-Match`.
   * @returns The new key set, or `not-modified` on 304.
   * @throws Error on a network failure, a timeout, any status other than 200 and 304, a body over
   * `JWKS_MAX_RESPONSE_BYTES` or a body that is not JSON.
   */
  async fetchKeySet(previousEtag: string | null): Promise<JwksFetchResult> {
    const response = await this.fetchFunction(this.url, {
      method: 'GET',
      headers: {
        Accept: ACCEPT_HEADER,
        ...(previousEtag === null ? {} : { 'If-None-Match': previousEtag }),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === HTTP_NOT_MODIFIED) {
      return { status: 'not-modified' };
    }
    if (!response.ok) {
      await discardBody(response);
      throw new Error(`The JWKS endpoint answered ${String(response.status)}.`);
    }
    const text = await readBodyWithinLimit(response);
    const document: unknown = JSON.parse(text);
    return { status: 'modified', document, etag: response.headers.get('ETag') };
  }
}

/**
 * Cancels a response body that will not be read, so the connection is released at once instead of
 * waiting for a body nobody consumes.
 *
 * @param response - A response whose body is not needed.
 */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel();
}

/**
 * Reads the body as text without ever holding more than `JWKS_MAX_RESPONSE_BYTES` of it. A declared
 * `Content-Length` over the limit is refused before any byte is read, and a body that goes over the
 * limit anyway (no length, or a wrong one) is cancelled as soon as it does.
 *
 * @param response - A successful response.
 * @returns The body decoded as UTF-8.
 * @throws Error when the body is larger than `JWKS_MAX_RESPONSE_BYTES`.
 */
async function readBodyWithinLimit(response: Response): Promise<string> {
  if (Number(response.headers.get('Content-Length') ?? 0) > JWKS_MAX_RESPONSE_BYTES) {
    await discardBody(response);
    throw new Error(BODY_TOO_LARGE_MESSAGE);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    const bytes: unknown = chunk.value;
    if (!(bytes instanceof Uint8Array)) {
      await reader.cancel();
      throw new Error('The JWKS response body is not made of bytes.');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > JWKS_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(BODY_TOO_LARGE_MESSAGE);
    }
    chunks.push(bytes);
    chunk = await reader.read();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
