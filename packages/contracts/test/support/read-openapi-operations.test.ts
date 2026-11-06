import { describe, expect, it } from 'vitest';

import { parseOpenApiOperations, readOpenApiOperations } from './read-openapi-operations';

const SPEC = `
openapi: 3.1.0
security:
  - bearerAuth: []
paths:
  /v1/things:
    parameters: []
    get:
      security: [{}, { bearerAuth: [] }]
    post: {}
  /v1/login:
    post:
      security: []
  /v1/things/{thingId}:
    delete:
      security:
        - {}
`;

describe('parseOpenApiOperations', () => {
  it('reads each method of each path and how it treats the access token', () => {
    expect(parseOpenApiOperations(SPEC, 'catalog')).toEqual([
      { method: 'GET', path: '/v1/things', access: 'optional', service: 'catalog' },
      { method: 'POST', path: '/v1/things', access: 'required', service: 'catalog' },
      { method: 'POST', path: '/v1/login', access: 'public', service: 'catalog' },
      { method: 'DELETE', path: '/v1/things/{thingId}', access: 'optional', service: 'catalog' },
    ]);
  });

  it('refuses a spec without paths instead of reporting no operations', () => {
    expect(() => parseOpenApiOperations('openapi: 3.1.0\n', 'auth')).toThrow();
  });

  it('refuses a path item that is a reference, because it would drop its operations', () => {
    expect(() =>
      parseOpenApiOperations("paths:\n  /v1/a:\n    $ref: './other.yaml'\n", 'auth'),
    ).toThrow(/\$ref/);
  });
});

describe('readOpenApiOperations', () => {
  it.each(['auth', 'catalog'] as const)('finds operations in the %s spec', (service) => {
    const operations = readOpenApiOperations(service);

    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every((operation) => operation.service === service)).toBe(true);
  });
});
