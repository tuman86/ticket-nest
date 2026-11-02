import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import { type Logger } from '@ticketnest/logger';
import { type RequestHandler } from 'express';

const HEALTH_PATH_PREFIX = '/health/';

/** One line per finished response: method, path (no query string), status and duration. */
export function createRequestLogger(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const startedAt = performance.now();
    const { method, path } = request;
    const level = path.startsWith(HEALTH_PATH_PREFIX) ? 'debug' : 'info';

    // Bind to the current context so the line still carries the correlation id.
    response.on(
      'finish',
      AsyncResource.bind(() => {
        logger[level](
          {
            method,
            path,
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          },
          'request completed',
        );
      }),
    );
    next();
  };
}
