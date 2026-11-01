import { type z } from 'zod';

import { ConfigError } from './config-error';

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const ROOT_PATH_LABEL = '(root)';
const MISSING_MESSAGE = 'required but missing';

/** Empty strings (e.g. `FOO=` in a .env file) count as not set, so defaults apply. */
function dropEmptyValues(source: EnvironmentSource): Record<string, string> {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  return Object.fromEntries(entries);
}

/** Describes each issue by variable name and reason only. Values may be secrets, so they are never included. */
function describeIssues(
  issues: readonly z.core.$ZodIssue[],
  environment: Record<string, string>,
): string[] {
  return issues.map((issue) => {
    const [firstKey] = issue.path;
    const name = issue.path.length > 0 ? issue.path.map(String).join('.') : ROOT_PATH_LABEL;
    const isMissing = typeof firstKey === 'string' && !(firstKey in environment);
    return `${name}: ${isMissing ? MISSING_MESSAGE : issue.message}`;
  });
}

/**
 * Validates the environment against a schema and returns the typed config.
 * Throws `ConfigError` listing every problem, so call it first in `main.ts`
 * and let the process fail fast at startup.
 */
export function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  source: EnvironmentSource = process.env,
): z.output<Schema> {
  const environment = dropEmptyValues(source);
  const result = schema.safeParse(environment);
  if (result.success) {
    return result.data;
  }

  const problems = describeIssues(result.error.issues, environment);
  const message = `Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`;
  throw new ConfigError(message, problems);
}
