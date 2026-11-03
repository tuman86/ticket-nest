import { describe, expect, it, vi } from 'vitest';

import { HttpJwksFetcher } from '@/http-jwks-fetcher';
import { JWKS_MAX_RESPONSE_BYTES } from '@/jwks-constants';

const JWKS_URL = 'http://auth-service:4001/.well-known/jwks.json';
const OK = 200;
const NOT_MODIFIED = 304;
const SERVER_ERROR = 500;

/**
 * @param response - What the fake server answers.
 * @returns A fetcher over a fake `fetch`, and that fake.
 */
function buildFetcher(response: Response) {
  const fetchFunction = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetcher: new HttpJwksFetcher({ url: JWKS_URL, fetchFunction }), fetchFunction };
}

/**
 * @param body - JSON text.
 * @param headers - Response headers.
 * @returns A 200 response with that body.
 */
function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: OK,
    headers: { 'Content-Type': 'application/jwk-set+json', ...headers },
  });
}

describe('HttpJwksFetcher', () => {
  it('returns the parsed document and the ETag on 200', async () => {
    const { fetcher } = buildFetcher(jsonResponse('{"keys":[]}', { ETag: '"abc"' }));

    await expect(fetcher.fetchKeySet(null)).resolves.toEqual({
      status: 'modified',
      document: { keys: [] },
      etag: '"abc"',
    });
  });

  it('returns a null ETag when the server sent none', async () => {
    const { fetcher } = buildFetcher(jsonResponse('{}'));

    await expect(fetcher.fetchKeySet(null)).resolves.toMatchObject({ etag: null });
  });

  it('returns not-modified on 304', async () => {
    const { fetcher } = buildFetcher(new Response(null, { status: NOT_MODIFIED }));

    await expect(fetcher.fetchKeySet('"abc"')).resolves.toEqual({ status: 'not-modified' });
  });

  it('sends a conditional GET only when it holds an ETag', async () => {
    const withoutEtag = buildFetcher(jsonResponse('{}'));
    const withEtag = buildFetcher(jsonResponse('{}'));

    await withoutEtag.fetcher.fetchKeySet(null);
    await withEtag.fetcher.fetchKeySet('"abc"');

    const [, firstInit] = withoutEtag.fetchFunction.mock.calls[0] ?? [];
    const [url, secondInit] = withEtag.fetchFunction.mock.calls[0] ?? [];
    expect(url).toBe(JWKS_URL);
    expect(new Headers(firstInit?.headers).has('If-None-Match')).toBe(false);
    expect(new Headers(secondInit?.headers).get('If-None-Match')).toBe('"abc"');
    expect(secondInit?.method).toBe('GET');
  });

  it('sets a timeout and refuses redirects, so a bad answer cannot hang or bounce the request', async () => {
    const { fetcher, fetchFunction } = buildFetcher(jsonResponse('{}'));

    await fetcher.fetchKeySet(null);

    const [, init] = fetchFunction.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
  });

  it('throws when the server answers with an error status', async () => {
    const { fetcher } = buildFetcher(new Response('boom', { status: SERVER_ERROR }));

    await expect(fetcher.fetchKeySet(null)).rejects.toThrow();
  });

  it('throws when the body is not JSON', async () => {
    const { fetcher } = buildFetcher(jsonResponse('<html>bad gateway</html>'));

    await expect(fetcher.fetchKeySet(null)).rejects.toThrow();
  });

  it('throws when the body is larger than the limit', async () => {
    const { fetcher } = buildFetcher(jsonResponse(' '.repeat(JWKS_MAX_RESPONSE_BYTES + 1)));

    await expect(fetcher.fetchKeySet(null)).rejects.toThrow();
  });

  it('throws when the request itself fails', async () => {
    const fetchFunction = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const fetcher = new HttpJwksFetcher({ url: JWKS_URL, fetchFunction });

    await expect(fetcher.fetchKeySet(null)).rejects.toThrow();
  });

  it('refuses a URL that is not http or https', () => {
    expect(() => new HttpJwksFetcher({ url: 'file:///etc/passwd' })).toThrow(TypeError);
    expect(() => new HttpJwksFetcher({ url: 'not a url' })).toThrow(TypeError);
  });
});
