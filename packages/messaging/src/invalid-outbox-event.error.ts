import { InternalServerError } from '@ticketnest/errors';

const INVALID_OUTBOX_EVENT_CODE = 'INVALID_OUTBOX_EVENT';

/**
 * 500: a service tried to write an event that does not match its schema. This is a bug in the
 * producer, never a client mistake. The message names only the failing fields, never their values,
 * because an event can carry ids that must not reach logs or responses.
 */
export class InvalidOutboxEventError extends InternalServerError {
  /**
   * @param failedFields - Dotted paths of the fields that failed validation.
   * @param cause - The Zod error, kept for debugging.
   */
  constructor(failedFields: readonly string[], cause: unknown) {
    super({
      code: INVALID_OUTBOX_EVENT_CODE,
      detail: `Event rejected by its schema. Failed fields: ${failedFields.join(', ')}`,
      cause,
    });
  }
}
