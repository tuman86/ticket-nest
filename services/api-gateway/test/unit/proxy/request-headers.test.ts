import { describe, expect, it } from 'vitest';

import { buildUpstreamRequestHeaders, FORWARDED_REQUEST_HEADERS } from '@/proxy/request-headers';

const BASE = { clientIp: '203.0.113.7', protocol: 'https', requestId: 'req-1' };

describe('buildUpstreamRequestHeaders', () => {
  it('copies the allowlisted headers unchanged', () => {
    const incoming = {
      authorization: 'Bearer abc.def.ghi',
      accept: 'application/json',
      'accept-language': 'en',
      'content-type': 'application/json',
      'idempotency-key': 'key-1',
      'if-match': '"v3"',
      'if-none-match': '"v2"',
      'user-agent': 'test/1.0',
    };

    expect(buildUpstreamRequestHeaders({ incoming, ...BASE })).toMatchObject(incoming);
  });

  it('drops everything that is not on the list, including spoofed identity headers', () => {
    const headers = buildUpstreamRequestHeaders({
      incoming: {
        cookie: 'session=1',
        host: 'api.ticketnest.example',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        'x-user-id': 'u1',
        'x-tenant-id': 't1',
        'x-role': 'ADMIN',
        'x-forwarded-host': 'evil.example',
        'x-custom': 'value',
      },
      ...BASE,
    });

    expect(Object.keys(headers).sort()).toEqual([
      'x-forwarded-for',
      'x-forwarded-proto',
      'x-request-id',
    ]);
  });

  it('overwrites X-Forwarded-For with the resolved address instead of appending to the client value', () => {
    const headers = buildUpstreamRequestHeaders({
      incoming: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7' },
      ...BASE,
    });

    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('omits X-Forwarded-For when the client address is unknown', () => {
    const headers = buildUpstreamRequestHeaders({ incoming: {}, ...BASE, clientIp: 'unknown' });

    expect(headers).not.toHaveProperty('x-forwarded-for');
  });

  it('sets the protocol and the request id itself', () => {
    const headers = buildUpstreamRequestHeaders({
      incoming: { 'x-request-id': 'client-chosen' },
      ...BASE,
    });

    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['x-request-id']).toBe('req-1');
  });

  it('leaves the request id out when there is none', () => {
    expect(
      buildUpstreamRequestHeaders({ incoming: {}, ...BASE, requestId: undefined }),
    ).not.toHaveProperty('x-request-id');
  });

  it('has an allowlist with no cookie and no identity header', () => {
    for (const name of FORWARDED_REQUEST_HEADERS) {
      expect(name).not.toMatch(/cookie|^x-/);
    }
  });
});
