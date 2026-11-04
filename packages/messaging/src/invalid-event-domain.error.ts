import { InternalServerError } from '@ticketnest/errors';

const INVALID_EVENT_DOMAIN_CODE = 'INVALID_EVENT_DOMAIN';

/**
 * 500: a service named an event domain that is not lower-case letters and underscores. The name
 * is fixed in code, so this is a programming error and never caused by a client.
 */
export class InvalidEventDomainError extends InternalServerError {
  /**
   * @param domain - The rejected name. It comes from code, never from a request.
   */
  constructor(domain: string) {
    super({
      code: INVALID_EVENT_DOMAIN_CODE,
      detail: `Invalid event domain: ${JSON.stringify(domain)}`,
    });
  }
}
