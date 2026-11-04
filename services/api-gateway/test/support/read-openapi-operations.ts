import { readFileSync } from 'node:fs';
import path from 'node:path';

const DOCS_API_DIRECTORY = path.resolve(import.meta.dirname, '../../../../docs/api');
const PATH_LINE = /^ {2}(\/\S*):\s*$/;
const METHOD_LINE = /^ {4}(get|post|put|patch|delete|head):\s*$/;
const SECURITY_LINE = /^ {6}security:\s*(.*)$/;

export type OpenApiAccess = 'required' | 'optional' | 'public';

export interface OpenApiOperation {
  readonly method: string;
  /** The path as written in the spec, such as `/v1/movies/{movieId}`. */
  readonly path: string;
  readonly access: OpenApiAccess;
  /** The service whose spec lists it. */
  readonly service: 'auth' | 'catalog';
}

/**
 * Reads the operations of a service's OpenAPI spec and how each one treats the access token. The
 * specs are hand-formatted with fixed indentation, so a line scan is enough and no YAML library is
 * needed: `security: []` is public, `security: [{}, ...]` is optional, anything else (or nothing,
 * since the spec has a global `bearerAuth`) is required.
 *
 * @param service - Which spec to read.
 * @returns Every operation in the spec.
 */
export function readOpenApiOperations(service: 'auth' | 'catalog'): OpenApiOperation[] {
  const text = readFileSync(
    path.join(DOCS_API_DIRECTORY, `${service}-service.openapi.yaml`),
    'utf8',
  );
  const operations = new Map<string, { method: string; path: string; access: OpenApiAccess }>();
  let currentPath: string | undefined;
  let currentKey: string | undefined;
  for (const line of text.split('\n')) {
    const pathMatch = PATH_LINE.exec(line);
    if (pathMatch !== null) {
      currentPath = pathMatch[1];
      currentKey = undefined;
      continue;
    }
    const methodMatch = METHOD_LINE.exec(line);
    if (methodMatch !== null && currentPath !== undefined) {
      const method = (methodMatch[1] ?? '').toUpperCase();
      currentKey = `${method} ${currentPath}`;
      operations.set(currentKey, { method, path: currentPath, access: 'required' });
      continue;
    }
    const securityMatch = SECURITY_LINE.exec(line);
    const operation = currentKey === undefined ? undefined : operations.get(currentKey);
    if (securityMatch !== null && operation !== undefined) {
      const value = (securityMatch[1] ?? '').trim();
      operation.access =
        value === '[]' ? 'public' : value.startsWith('[{}') ? 'optional' : 'required';
    }
  }
  return [...operations.values()].map((operation) => ({ ...operation, service }));
}
