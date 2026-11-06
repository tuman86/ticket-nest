import { InternalServerError } from '@ticketnest/errors';

/**
 * 500: a route was wired with a permission key that is not in the catalogue. It is a programming
 * error found while the routes are built at startup, so the service refuses to start instead of
 * answering 403 to everyone. Like every server error, its detail never reaches a client.
 */
export class InvalidGuardConfigurationError extends InternalServerError {
  /**
   * @param unknownKey - The key that is not in the catalogue, named in the message for the log.
   */
  constructor(unknownKey: string) {
    super({
      code: 'INVALID_GUARD_CONFIGURATION',
      detail: `Unknown permission key \`${unknownKey}\` in an access guard. Use a key of the permission catalogue.`,
    });
  }
}
