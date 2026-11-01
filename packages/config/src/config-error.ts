// TODO: extend AppError once a shared one exists (code-quality rules: typed errors).
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
