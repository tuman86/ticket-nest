import { InternalServerError } from '@ticketnest/errors';
import { type Response } from 'express';

import { type AccessMode } from './access-rules';
import { type UpstreamName } from './route-table';

const ROUTE_CONTEXT_LOCALS_KEY = 'resolvedRoute';

/** What the gateway decided about a request before it is authenticated and forwarded. */
export interface ResolvedRoute {
  readonly upstream: UpstreamName;
  readonly accessMode: AccessMode;
}

/**
 * Remembers which service owns the request and how its token is treated.
 *
 * @param response - The response of the current request.
 * @param route - The decision.
 */
export function setResolvedRoute(response: Response, route: ResolvedRoute): void {
  response.locals[ROUTE_CONTEXT_LOCALS_KEY] = route;
}

/**
 * Reads the decision made by the route resolution middleware.
 *
 * @param response - The response of the current request.
 * @returns The resolved route.
 * @throws InternalServerError when no route resolution ran before this handler.
 */
export function getResolvedRoute(response: Response): ResolvedRoute {
  const route = response.locals[ROUTE_CONTEXT_LOCALS_KEY] as ResolvedRoute | undefined;
  if (route === undefined) {
    throw new InternalServerError({ detail: 'The route is missing its route resolution step.' });
  }
  return route;
}
