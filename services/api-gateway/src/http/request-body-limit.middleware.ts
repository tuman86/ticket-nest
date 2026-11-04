import { type RequestHandler } from 'express';
import { z } from 'zod';

import { createBodyTooLargeError } from '../proxy/limit-body-size';

/** A `Content-Length` header: digits only. Anything else declares no usable length. */
const ContentLengthSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value));

/**
 * Builds the middleware that refuses a request whose declared `Content-Length` is over the limit,
 * before anything is authenticated or sent to a service. A chunked body, which declares no length,
 * is counted while it streams (`limitBodySize`).
 *
 * @param maxBytes - The largest body accepted, in bytes.
 * @returns An Express middleware.
 */
export function createRequestBodyLimit(maxBytes: number): RequestHandler {
  /**
   * @param request - The incoming request.
   * @param _response - Unused.
   * @param next - Called when the declared length is within the limit or absent.
   * @throws RequestRejectedError (413) when `Content-Length` is over the limit.
   */
  return (request, _response, next) => {
    const declaredBytes = ContentLengthSchema.safeParse(request.headers['content-length']);
    if (declaredBytes.success && declaredBytes.data > maxBytes) {
      throw createBodyTooLargeError();
    }
    next();
  };
}
