import { InternalServerError } from '@ticketnest/errors';

const BROKER_UNAVAILABLE_CODE = 'BROKER_UNAVAILABLE';

/**
 * 500: the message broker cannot be reached (it refused the connection, or the connection or channel
 * closed). The relay treats it as a connection-level failure: no row is charged an attempt, and the
 * loop backs off as a whole (ADR-0007).
 *
 * The detail is fixed text. The cause is kept for debugging but never copied into the detail,
 * because a driver message can contain the broker URL, which carries a password.
 */
export class BrokerUnavailableError extends InternalServerError {
  /**
   * @param cause - The driver error that explains why the broker could not be reached.
   */
  constructor(cause: unknown) {
    super({
      code: BROKER_UNAVAILABLE_CODE,
      detail: 'The message broker cannot be reached.',
      cause,
    });
  }
}
