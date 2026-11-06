export { getAccessScope } from './access-scope-accessors';
export {
  createAccessGuard,
  type AccessGuardDependencies,
  type AccessRequirement,
  type CreateAccessGuard,
} from './create-access-guard';
export {
  createAuthenticateMiddleware,
  type AuthenticateMiddlewareDependencies,
} from './authenticate-middleware';
export {
  findAuthenticatedPrincipal,
  getAuthenticatedPrincipal,
  setAuthenticatedPrincipal,
} from './authenticated-principal-accessors';
export { createOptionalAuthenticateMiddleware } from './optional-authenticate-middleware';
