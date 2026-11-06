/**
 * The test helpers other workspaces share, exported as `@ticketnest/contracts/testing`. Each reads a
 * document under `docs/` and fails loudly when its structure changes, so a check built on it cannot
 * pass on zero rows.
 */
export {
  readOpenApiOperations,
  type OpenApiAccess,
  type OpenApiOperation,
  type OpenApiService,
} from './read-openapi-operations';
export { readGrantMatrix, type GrantMatrix } from './read-grant-matrix';
