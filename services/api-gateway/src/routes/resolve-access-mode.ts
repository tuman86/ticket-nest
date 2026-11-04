import { ACCESS_RULES, type AccessMode, type AccessRule } from './access-rules';

const PATH_PARAMETER = /\{[^/}]+\}/g;
const REGEX_SPECIAL_CHARACTERS = /[.*+?^$()|[\]\\]/g;

interface CompiledRule {
  readonly method: string;
  readonly matcher: RegExp;
  readonly mode: AccessRule['mode'];
}

/**
 * @param rule - A rule whose path is written as in the OpenAPI spec.
 * @returns The rule with its path turned into a matcher: each `{parameter}` is one path segment.
 */
function compileRule(rule: AccessRule): CompiledRule {
  const pattern = rule.path
    .replace(REGEX_SPECIAL_CHARACTERS, '\\$&')
    .replace(PATH_PARAMETER, '[^/]+');
  return { method: rule.method, matcher: new RegExp(`^${pattern}$`), mode: rule.mode };
}

const COMPILED_RULES: readonly CompiledRule[] = ACCESS_RULES.map(compileRule);

/**
 * Decides how a request's access token is treated. `HEAD` is treated as the `GET` of the same
 * path, because a service answers it from the same handler.
 *
 * @param method - The HTTP method, any letter case.
 * @param path - The request path, without the query string.
 * @returns `public` or `optional` when a rule lists the route, otherwise `required`.
 */
export function resolveAccessMode(method: string, path: string): AccessMode {
  const upperMethod = method.toUpperCase();
  const effectiveMethod = upperMethod === 'HEAD' ? 'GET' : upperMethod;
  const rule = COMPILED_RULES.find(
    (candidate) => candidate.method === effectiveMethod && candidate.matcher.test(path),
  );
  return rule?.mode ?? 'required';
}
