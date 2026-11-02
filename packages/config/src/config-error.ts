import { InternalServerError } from '@ticketnest/errors';

/** Startup failure: the environment is missing or invalid. Lists variable names, never values. */
export class ConfigError extends InternalServerError {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super({ detail: message, code: 'CONFIG_INVALID' });
    this.name = 'ConfigError';
  }
}
