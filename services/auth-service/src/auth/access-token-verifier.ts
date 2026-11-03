import { type AuthenticatedPrincipal } from './authenticated-principal';

/**
 * Checks an access token. The middleware depends on this interface, so the local verifier can be
 * replaced by the shared auth-middleware package without touching controllers.
 */
export interface AccessTokenVerifier {
  /**
   * Verifies the signature and the standard claims of an access token.
   *
   * @param token - The compact JWT, without the `Bearer ` prefix.
   * @returns The caller the token names.
   * @throws InvalidAccessTokenError when the token is not valid for any reason.
   */
  verify(token: string): Promise<AuthenticatedPrincipal>;
}
