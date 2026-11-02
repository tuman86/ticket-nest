export interface AppErrorDefinition {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  /** Slug appended to `PROBLEM_TYPE_BASE_URL`. */
  readonly problemType: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AppErrorOptions {
  /** Human-readable explanation of this occurrence. Never put secrets in it. */
  readonly detail?: string;
  /** Overrides the default machine code, e.g. `SEAT_UNAVAILABLE` for a `ConflictError`. */
  readonly code?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Extra problem members (RFC 9457 extensions), e.g. `errors` for validation. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Base of every error the services throw on purpose. Subclasses fix the HTTP status, code,
 * title and problem type; one error handler turns them into `application/problem+json`.
 */
export abstract class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly problemType: string;
  readonly detail: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, unknown>>;

  protected constructor(definition: AppErrorDefinition, options: AppErrorOptions = {}) {
    super(
      options.detail ?? definition.title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.status = definition.status;
    this.code = options.code ?? definition.code;
    this.title = definition.title;
    this.problemType = definition.problemType;
    this.detail = options.detail;
    this.headers = { ...definition.headers, ...options.headers };
    this.extensions = options.extensions ?? {};
  }
}
