import { BadRequestError, NotFoundError } from '@ticketnest/errors';
import { type RequestHandler } from 'express';

import { resolveAccessMode } from './resolve-access-mode';
import { isSafePath, resolveRoute } from './resolve-route';
import { setResolvedRoute } from './route-context';

/**
 * Decides which service owns the request and how its token is treated, before anything is
 * authenticated or forwarded.
 *
 * @param request - The incoming request.
 * @param response - Receives the decision.
 * @param next - Called when the path belongs to a known service.
 * @throws BadRequestError when the path has a segment that must not be forwarded (`..`, `%2f`).
 * @throws NotFoundError when no service owns the path.
 */
export const handleRouteResolution: RequestHandler = (request, response, next) => {
  if (!isSafePath(request.path)) {
    throw new BadRequestError({ detail: 'The request path is not valid.' });
  }
  const route = resolveRoute(request.path);
  if (route === undefined) {
    throw new NotFoundError({ detail: 'No such endpoint.' });
  }
  setResolvedRoute(response, {
    upstream: route.upstream,
    accessMode: resolveAccessMode(request.method, request.path),
  });
  next();
};
