import { describe, expect, it } from 'vitest';

import { ACCESS_RULES, UNBUILT_PUBLIC_AUTH_OPERATIONS } from '@/routes/access-rules';
import { resolveAccessMode } from '@/routes/resolve-access-mode';
import { resolveRoute } from '@/routes/resolve-route';

import { readOpenApiOperations } from '../../support/read-openapi-operations';

const PATH_PARAMETER = /\{[^/}]+\}/g;
const SAMPLE_SEGMENT = 'sample-id';

/** Operations the gateway can be asked for: everything under `/v1` in either spec. */
const OPERATIONS = [...readOpenApiOperations('auth'), ...readOpenApiOperations('catalog')].filter(
  (operation) => operation.path.startsWith('/v1/'),
);

/** Spec operations that are public but deliberately not exposed as public yet. */
const UNBUILT = new Set(UNBUILT_PUBLIC_AUTH_OPERATIONS);

/**
 * @param operation - A spec operation.
 * @returns Whether the gateway holds it back on the default `required` mode until it is built.
 */
function isUnbuilt(operation: { method: string; path: string }): boolean {
  return UNBUILT.has(`${operation.method.toUpperCase()} ${operation.path}`);
}

/**
 * @param template - A spec path such as `/v1/movies/{movieId}`.
 * @returns A concrete path a client could send for it.
 */
function fillParameters(template: string): string {
  return template.replace(PATH_PARAMETER, SAMPLE_SEGMENT);
}

describe('access rules against the OpenAPI specs', () => {
  it('found the operations to compare, so the scan itself is not broken', () => {
    expect(OPERATIONS.length).toBeGreaterThan(50);
    expect(OPERATIONS.filter((operation) => operation.access === 'public').length).toBe(10);
    expect(OPERATIONS.filter(isUnbuilt)).toHaveLength(UNBUILT_PUBLIC_AUTH_OPERATIONS.length);
    expect(OPERATIONS.filter((operation) => operation.access === 'optional').length).toBe(19);
  });

  it.each(
    OPERATIONS.filter((operation) => !isUnbuilt(operation)).map((operation) => [
      `${operation.method} ${operation.path}`,
      operation,
    ]),
  )('treats %s the way its spec does', (_name, operation) => {
    expect(resolveAccessMode(operation.method, fillParameters(operation.path))).toBe(
      operation.access,
    );
  });

  it.each(
    OPERATIONS.filter(isUnbuilt).map((operation) => [
      `${operation.method} ${operation.path}`,
      operation,
    ]),
  )(
    'keeps %s on the default token requirement until auth-service builds it',
    (_name, operation) => {
      expect(operation.access).toBe('public');
      expect(resolveAccessMode(operation.method, fillParameters(operation.path))).toBe('required');
    },
  );

  it('lists no rule that the specs do not have, with the same mode', () => {
    for (const rule of ACCESS_RULES) {
      const operation = OPERATIONS.find(
        (candidate) => candidate.method === rule.method && candidate.path === rule.path,
      );
      expect(operation, `${rule.method} ${rule.path} is in no spec`).toBeDefined();
      expect(operation?.access).toBe(rule.mode);
    }
  });
});

describe('route table against the OpenAPI specs', () => {
  it.each(OPERATIONS.map((operation) => [`${operation.method} ${operation.path}`, operation]))(
    'routes %s to the service whose spec lists it',
    (_name, operation) => {
      expect(resolveRoute(fillParameters(operation.path))?.upstream).toBe(operation.service);
    },
  );
});

describe('resolveAccessMode', () => {
  it('treats HEAD like the GET of the same path', () => {
    expect(resolveAccessMode('HEAD', '/v1/movies/abc')).toBe('optional');
  });

  it('does not let a different method inherit a route’s mode', () => {
    expect(resolveAccessMode('POST', '/v1/movies')).toBe('required');
    expect(resolveAccessMode('DELETE', '/v1/auth/login')).toBe('required');
  });

  it('matches a parameter as exactly one segment', () => {
    expect(resolveAccessMode('GET', '/v1/movies/abc/extra')).toBe('required');
    expect(resolveAccessMode('GET', '/v1/movies/')).toBe('required');
  });

  it('is case-insensitive about the method only', () => {
    expect(resolveAccessMode('get', '/v1/search')).toBe('optional');
    expect(resolveAccessMode('GET', '/V1/search')).toBe('required');
  });
});
