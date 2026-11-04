import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import { type Logger } from '@ticketnest/logger';
import { type RequestHandler } from 'express';

const HEALTH_PATH_PREFIX = '/health/';

/**
 * Logs one line per finished response: method, path (no query string), status and duration.
 * Health probes log at debug level so they do not drown real traffic.
 *
 * @param logger - Receives the lines.
 * @returns An Express middleware. Call it inside the correlation context so lines carry the id.
 */
export function createRequestLogger(logger: Logger): RequestHandler {
  /**
   * @param request - The incoming request.
   * @param response - Its `finish` event triggers the log line.
   * @param next - Passes control on at once.
   */
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
