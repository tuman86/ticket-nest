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
    post:
      x-permissions: ['thing:create', 'thing:manage']
      x-recent-login: true
  /v1/login:
    post:
      security: []
  /v1/things/{thingId}:
    delete:
      x-permissions: [self]
      security:
        - {}
`;

describe('parseOpenApiOperations', () => {
  it('reads each method of each path and how it treats the access token', () => {
    expect(parseOpenApiOperations(SPEC, 'catalog')).toEqual([
      {
        method: 'GET',
        path: '/v1/things',
        access: 'optional',
        service: 'catalog',
        permissions: [],
        recentLogin: false,
      },
      {
        method: 'POST',
        path: '/v1/things',
        access: 'required',
        service: 'catalog',
        permissions: ['thing:create', 'thing:manage'],
        recentLogin: true,
      },
      {
        method: 'POST',
        path: '/v1/login',
        access: 'public',
        service: 'catalog',
        permissions: [],
        recentLogin: false,
      },
      {
        method: 'DELETE',
        path: '/v1/things/{thingId}',
        access: 'optional',
        service: 'catalog',
        permissions: ['self'],
        recentLogin: false,
      },
    ]);
  });

  it.each([
    ['not a list', "x-permissions: 'role:manage'"],
    ['a list with an empty key', "x-permissions: ['']"],
    ['a list with a non-string', 'x-permissions: [1]'],
  ])('refuses x-permissions that is %s', (_name, line) => {
    expect(() =>
      parseOpenApiOperations(`paths:\n  /v1/a:\n    get:\n      ${line}\n`, 'auth'),
    ).toThrow();
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
