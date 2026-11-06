import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

const DOCS_API_DIRECTORY = path.resolve(import.meta.dirname, '../../../../docs/api');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

/** The services that have an OpenAPI spec under `docs/api`. */
export type OpenApiService = 'auth' | 'catalog';

export type OpenApiAccess = 'required' | 'optional' | 'public';

export interface OpenApiOperation {
  readonly method: string;
  /** The path as written in the spec, such as `/v1/movies/{movieId}`. */
  readonly path: string;
  readonly access: OpenApiAccess;
  /** The service whose spec lists it. */
  readonly service: OpenApiService;
  /**
   * The operation's `x-permissions`: holding any one of them is enough. `self` is a marker, not a
   * key. Empty when the operation has none (public and optional-auth operations).
   */
  readonly permissions: readonly string[];
  /** Whether the operation is marked `x-recent-login: true`. */
  readonly recentLogin: boolean;
}

/** Only the parts of an operation this reader looks at; everything else is ignored. */
const OperationFields = z.looseObject({
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  'x-permissions': z.array(z.string().min(1)).optional(),
  'x-recent-login': z.boolean().optional(),
});

/** A spec, as far as this reader goes: its path items, each keyed by method or other field. */
const OpenApiDocument = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/**
 * Turns an operation's `security` list into how it treats the access token. The specs declare a
 * global `bearerAuth`, so a missing list means `required`; `security: []` is public; a list with an
 * empty requirement (`{}`) lets an anonymous caller through, so the token is optional.
 *
 * @param security - The operation's own `security` value, `undefined` when it has none.
 * @returns The access mode the spec describes.
 */
function resolveAccess(
  security: readonly Readonly<Record<string, readonly string[]>>[] | undefined,
): OpenApiAccess {
  if (security === undefined) return 'required';
  if (security.length === 0) return 'public';
  return security.some((requirement) => Object.keys(requirement).length === 0)
    ? 'optional'
    : 'required';
}

/**
 * Reads the operations out of the text of an OpenAPI spec.
 *
 * @param text - The YAML of the spec.
 * @param service - The service the spec belongs to, copied onto every operation.
 * @returns Every operation, in the order the spec lists them.
 * @throws Error when the text is not a spec with `paths`, an `x-permissions` is not a list of
 *   non-empty strings, or a path item is a `$ref` (this reader does not follow references, and
 *   skipping one would silently drop its operations).
 */
export function parseOpenApiOperations(text: string, service: OpenApiService): OpenApiOperation[] {
  const document = OpenApiDocument.parse(parse(text));
  const operations: OpenApiOperation[] = [];
  for (const [pathName, item] of Object.entries(document.paths)) {
    if ('$ref' in item) {
      throw new Error(`Path ${pathName} is a $ref; the OpenAPI reader does not follow references.`);
    }
    for (const method of HTTP_METHODS) {
      if (!(method in item)) continue;
      const fields = OperationFields.parse(item[method]);
      operations.push({
        method: method.toUpperCase(),
        path: pathName,
        access: resolveAccess(fields.security),
        service,
        permissions: fields['x-permissions'] ?? [],
        recentLogin: fields['x-recent-login'] === true,
      });
    }
  }
  return operations;
}

/**
 * Reads the operations of a service's OpenAPI spec from `docs/api` and how each one treats the
 * access token.
 *
 * @param service - Which spec to read.
 * @returns Every operation in the spec.
 */
export function readOpenApiOperations(service: OpenApiService): OpenApiOperation[] {
  const text = readFileSync(
    path.join(DOCS_API_DIRECTORY, `${service}-service.openapi.yaml`),
    'utf8',
  );
  return parseOpenApiOperations(text, service);
}
