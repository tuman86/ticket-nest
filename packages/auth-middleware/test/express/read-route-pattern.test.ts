import { type Request } from 'express';
import { describe, expect, it } from 'vitest';

import { readRoutePattern, UNMATCHED_ROUTE_PATTERN } from '@/express/read-route-pattern';

/**
 * @param fields - The parts of an Express request the reader looks at.
 * @returns A request with only those parts.
 */
function buildRequest(fields: { baseUrl: string; route?: unknown }): Request {
  return fields as unknown as Request;
}

describe('readRoutePattern', () => {
  it('joins the router mount prefix and the route path, never the real URL', () => {
    const request = buildRequest({ baseUrl: '/v1', route: { path: '/roles/:roleId' } });

    expect(readRoutePattern(request)).toBe('/v1/roles/:roleId');
  });

  it('works for a route on the app itself', () => {
    const request = buildRequest({ baseUrl: '', route: { path: '/v1/users' } });

    expect(readRoutePattern(request)).toBe('/v1/users');
  });

  it.each([
    ['no route was matched', undefined],
    ['the route has no path', {}],
    ['the path is a pattern object', { path: /^\/x$/ }],
  ])('answers the placeholder when %s', (_label, route) => {
    expect(readRoutePattern(buildRequest({ baseUrl: '/v1', route }))).toBe(UNMATCHED_ROUTE_PATTERN);
  });
});
