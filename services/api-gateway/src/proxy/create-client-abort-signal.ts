import { type Response } from 'express';

/**
 * Creates a signal that fires when the client goes away before the answer is fully sent, so the
 * call to the service is cancelled instead of running for nobody.
 *
 * @param response - The client's response. Its `close` event ends the signal's life.
 * @returns A signal that aborts if the connection closes before the response finished.
 */
export function createClientAbortSignal(response: Response): AbortSignal {
  const abortController = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) {
      abortController.abort();
    }
  });
  return abortController.signal;
}
