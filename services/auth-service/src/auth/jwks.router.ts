import { MethodNotAllowedError } from '@ticketnest/errors';
import { Router } from 'express';

import {
  JWKS_ALLOWED_METHODS,
  JWKS_CACHE_CONTROL,
  JWKS_CONTENT_TYPE,
  JWKS_PATH,
} from './jwks-constants';
import { type JwksService } from './jwks.service';

export interface JwksRouterDependencies {
  readonly jwksService: JwksService;
}

/**
 * Mounts `GET /.well-known/jwks.json`: public, unauthenticated and read-only. Express answers
 * `HEAD` with the `GET` handler and turns a matching `If-None-Match` into a 304 because the
 * response carries a strong ETag. Every other method gets a 405 problem with an `Allow` header.
 *
 * @param dependencies - The service that holds the prebuilt key set.
 * @returns A router for the key set path.
 */
export function createJwksRouter(dependencies: JwksRouterDependencies): Router {
  const { jwksService } = dependencies;
  const router = Router();

  router
    .route(JWKS_PATH)
    .get((_request, response) => {
      const { body, etag } = jwksService.getDocument();
      response
        .set({ 'Content-Type': JWKS_CONTENT_TYPE, 'Cache-Control': JWKS_CACHE_CONTROL, ETag: etag })
        .send(body);
    })
    .all((request, _response, next) => {
      next(
        new MethodNotAllowedError(JWKS_ALLOWED_METHODS, {
          detail: `This path does not accept ${request.method}.`,
        }),
      );
    });

  return router;
}
