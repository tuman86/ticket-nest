import { InternalServerError } from '@ticketnest/errors';

const INVALID_BROKER_URL_CODE = 'INVALID_BROKER_URL';

/**
 * 500: the broker URL given to the publisher cannot be parsed. Config validation should have caught
 * it, so this is a deployment mistake that stops the service at startup.
 *
 * It carries no cause and no property holding the URL. The URL has the broker password in it, and
 * the error that `new URL` throws keeps the whole input on an `input` property that a logger would
 * print.
 */
export class InvalidBrokerUrlError extends InternalServerError {
  constructor() {
    super({
      code: INVALID_BROKER_URL_CODE,
      detail: 'The broker URL is not a valid URL.',
    });
  }
}
