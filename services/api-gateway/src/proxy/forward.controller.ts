import { pipeline } from 'node:stream/promises';

import { MethodNotAllowedError } from '@ticketnest/errors';
import { getCorrelationId } from '@ticketnest/logger';
import { readClientIp } from '@ticketnest/rate-limit';
import { type RequestHandler } from 'express';
import { z } from 'zod';

import { getResolvedRoute } from '../routes/route-context';
import { buildPathAndQuery } from './build-path-and-query';
import { createClientAbortSignal } from './create-client-abort-signal';
import { type ForwardService } from './forward.service';
import { FORWARDED_METHODS } from './upstream-client';

const MethodSchema = z.enum(FORWARDED_METHODS);

export interface ForwardControllerDependencies {
  readonly forwardService: ForwardService;
}

/**
 * Builds the handler that forwards a request to the service the route resolution chose and
 * streams the answer back. It parses the method, makes one service call and writes the result.
 *
 * @param dependencies - The forward service.
 * @returns An Express handler. Errors it throws reach the shared error handler (Express 5).
 */
export function createForwardController(
  dependencies: ForwardControllerDependencies,
): RequestHandler {
  /**
   * @param request - The incoming request.
   * @param response - Receives the service's status, headers and body.
   * @throws MethodNotAllowedError when the method is not one the gateway forwards.
   */
  return async (request, response): Promise<void> => {
    const method = MethodSchema.safeParse(request.method);
    if (!method.success) {
      throw new MethodNotAllowedError(FORWARDED_METHODS);
    }
    const forwarded = await dependencies.forwardService.forward({
      upstream: getResolvedRoute(response).upstream,
      method: method.data,
      pathAndQuery: buildPathAndQuery(request),
      headers: request.headers,
      body: request,
      clientIp: readClientIp(request.ip),
      protocol: request.protocol,
      requestId: getCorrelationId(),
      signal: createClientAbortSignal(response),
    });
    response.status(forwarded.status);
    for (const [name, value] of Object.entries(forwarded.headers)) {
      response.setHeader(name, value);
    }
    await pipeline(forwarded.body, response);
  };
}
