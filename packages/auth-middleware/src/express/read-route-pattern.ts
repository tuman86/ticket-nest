import { type Request } from 'express';

/** What the log shows when Express matched no route (a guard mounted with `use`). */
export const UNMATCHED_ROUTE_PATTERN = 'unmatched';

/**
 * Reads the route pattern the request matched, such as `/v1/roles/:roleId`, so a log line never
 * holds the raw URL with its ids and query. The mount prefix of a router comes from `baseUrl`, so
 * routers must be mounted on static prefixes.
 *
 * @param request - The incoming request.
 * @returns The pattern, or `unmatched` when the guard did not run on a route.
 */
export function readRoutePattern(request: Request): string {
  const route: unknown = request.route;
  const path = typeof route === 'object' && route !== null && 'path' in route ? route.path : null;
  return typeof path === 'string' ? `${request.baseUrl}${path}` : UNMATCHED_ROUTE_PATTERN;
}
