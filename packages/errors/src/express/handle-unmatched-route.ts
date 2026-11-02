import { type RequestHandler } from 'express';

import { NotFoundError } from '../http-errors';

/** Mount after all routes so unknown paths answer problem+json instead of Express's HTML page. */
export const handleUnmatchedRoute: RequestHandler = (_request, _response, next) => {
  next(new NotFoundError({ detail: 'No route matches this request.' }));
};
