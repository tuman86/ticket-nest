import { EventEnvelope } from '@ticketnest/contracts';

/** The outcome of reading a stored outbox payload back as an event envelope. */
export type ParsedStoredEvent =
  | { readonly isValid: true; readonly event: EventEnvelope }
  | {
      readonly isValid: false;
      /** Dotted paths of the failed fields, or `(event)` for the whole value. Never values. */
      readonly failedFields: readonly string[];
    };

/**
 * Checks that a stored payload is still a valid event envelope before it is published. The writer
 * stored it parsed, so a failure means the row was altered or written by something else, and a
 * retry cannot fix it.
 *
 * @param payload - The JSON stored in the outbox row.
 * @returns The envelope, or the names (never the values) of the fields that failed.
 */
export function parseStoredEvent(payload: unknown): ParsedStoredEvent {
  const result = EventEnvelope.safeParse(payload);
  if (result.success) {
    return { isValid: true, event: result.data };
  }
  return {
    isValid: false,
    failedFields: result.error.issues.map((issue) => issue.path.join('.') || '(event)'),
  };
}
