import { InternalServerError } from '@ticketnest/errors';

const PUBLISH_NOT_CONFIRMED_CODE = 'PUBLISH_NOT_CONFIRMED';

/** Why the broker did not confirm a publish while the connection was up. */
export type PublishFailureReason = 'nack' | 'confirm_timeout';

/**
 * 500: the connection is up but the broker did not confirm one event (it refused it, or no answer
 * came within the confirm timeout). The relay charges that row an attempt and retries it later
 * (ADR-0007).
 */
export class PublishNotConfirmedError extends InternalServerError {
  /** A short code that is safe to log and to store, never event content. */
  readonly reason: PublishFailureReason;

  /**
   * @param reason - Why the confirm did not come.
   * @param cause - The driver error behind it, when there is one.
   */
  constructor(reason: PublishFailureReason, cause?: unknown) {
    super({
      code: PUBLISH_NOT_CONFIRMED_CODE,
      detail: `The broker did not confirm the event: ${reason}.`,
      cause,
    });
    this.reason = reason;
  }
}
