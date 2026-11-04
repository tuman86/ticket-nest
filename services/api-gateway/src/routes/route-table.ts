/** The services the gateway forwards to. A new service is one name here and one origin in config. */
export type UpstreamName = 'auth' | 'catalog';

/** One path prefix and the service that owns everything below it. */
export interface RouteEntry {
  /** A path such as `/v1/auth`. It matches the path itself and anything below it, whole segments only. */
  readonly prefix: string;
  readonly upstream: UpstreamName;
}

/**
 * Which service handles which path. This list is an allowlist: a path that matches no prefix is
 * answered with 404 by the gateway and never forwarded, so internal endpoints such as
 * `/.well-known/jwks.json` and `/healthz` cannot be reached through it. Prefixes come from the
 * OpenAPI specs in `docs/api/`. booking-service and payment-service have no spec yet, so they
 * have no entry.
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  { prefix: '/v1/auth', upstream: 'auth' },
  { prefix: '/v1/users', upstream: 'auth' },
  { prefix: '/v1/roles', upstream: 'auth' },
  { prefix: '/v1/permissions', upstream: 'auth' },
  { prefix: '/v1/search', upstream: 'catalog' },
  { prefix: '/v1/schedules', upstream: 'catalog' },
  { prefix: '/v1/movies', upstream: 'catalog' },
  { prefix: '/v1/venues', upstream: 'catalog' },
  { prefix: '/v1/screens', upstream: 'catalog' },
  { prefix: '/v1/stations', upstream: 'catalog' },
  { prefix: '/v1/routes', upstream: 'catalog' },
  { prefix: '/v1/bus-layouts', upstream: 'catalog' },
  { prefix: '/v1/coach-layouts', upstream: 'catalog' },
  { prefix: '/v1/trains', upstream: 'catalog' },
  { prefix: '/v1/operators', upstream: 'catalog' },
  { prefix: '/v1/cancellation-policies', upstream: 'catalog' },
  { prefix: '/v1/fee-config', upstream: 'catalog' },
];
