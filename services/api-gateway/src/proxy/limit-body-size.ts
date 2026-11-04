import { Transform, type Readable } from 'node:stream';

import { RequestRejectedError } from '@ticketnest/errors/express';

const PAYLOAD_TOO_LARGE = 413;

/**
 * Builds the error for a request body over the limit, so the declared-length check and the
 * streaming check answer with the same 413.
 *
 * @returns A 413 `RequestRejectedError` with a fixed, safe detail.
 */
export function createBodyTooLargeError(): RequestRejectedError {
  return new RequestRejectedError(PAYLOAD_TOO_LARGE, { detail: 'The request body is too large.' });
}

/**
 * Wraps a request body so it fails once more than `maxBytes` have passed through. The
 * `Content-Length` header is checked up front by the body limit middleware; this catches a chunked
 * body, which declares no length, and a client that lies about it.
 *
 * @param source - The client's request body.
 * @param maxBytes - The most bytes allowed through.
 * @returns A stream with the same bytes that errors with a 413 `RequestRejectedError` past the limit.
 * @throws RequestRejectedError (413) on the returned stream once more than `maxBytes` have passed.
 */
export function limitBodySize(source: Readable, maxBytes: number): Readable {
  let receivedBytes = 0;
  const limited = new Transform({
    /**
     * Counts one chunk and passes it on, or fails the stream when the total is over the limit.
     *
     * @param chunk - The next piece of the request body.
     * @param _encoding - Unused: chunks are buffers.
     * @param callback - Called with the chunk, or with the 413 error.
     */
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(createBodyTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  // Not `pipeline`: on an error it would destroy the client's socket, and the 413 could not be sent.
  limited.once('error', () => {
    source.unpipe(limited);
    source.resume();
  });
  return source.pipe(limited);
}
