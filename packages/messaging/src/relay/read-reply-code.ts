/**
 * Reads the AMQP reply code amqplib attaches to the errors it raises for a close frame from the
 * broker (`code`). Errors that do not come from a close frame, such as a reset socket, have none.
 *
 * @param error - Whatever an AMQP operation rejected with.
 * @returns The numeric reply code, or `undefined` when the error carries none.
 */
export function readReplyCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'number' ? error.code : undefined;
}
