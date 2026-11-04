import { describe, expect, it } from 'vitest';

import { filterUpstreamResponseHeaders } from '@/proxy/response-headers';

describe('filterUpstreamResponseHeaders', () => {
  it('keeps content, caching and rate-limit headers, and multi-value headers as a list', () => {
    const headers = {
      'content-type': 'application/json',
      'content-length': '12',
      'cache-control': 'no-store',
      etag: '"v1"',
      location: '/v1/movies/1',
      'retry-after': '5',
      'ratelimit-limit': '10',
      'set-cookie': ['a=1', 'b=2'],
    };

    expect(filterUpstreamResponseHeaders(headers)).toEqual(headers);
  });

  it.each([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'server',
    'x-powered-by',
    'x-request-id',
    'access-control-allow-origin',
    'access-control-allow-credentials',
  ])('drops %s', (name) => {
    expect(filterUpstreamResponseHeaders({ [name]: 'value' })).toEqual({});
  });

  it('skips a header whose value is undefined', () => {
    expect(filterUpstreamResponseHeaders({ etag: undefined })).toEqual({});
  });
});
