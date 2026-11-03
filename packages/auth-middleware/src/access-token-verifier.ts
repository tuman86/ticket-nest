import { type AuthenticatedPrincipal } from './authenticated-principal';

/**
 * Checks an access token. The middleware depends on this interface, so controllers never see which
 * verifier (and which key source) stands behind it.
 */
export interface AccessTokenVerifier {
  /**
   * Verifies the signature and the standard claims of an access token.
   *
   * @param token - The compact JWT, without the `Bearer ` prefix.
   * @returns The caller the token names.
   * @throws InvalidAccessTokenError when the token is not valid for any reason.
   * @throws KeySetUnavailableError when the keys needed to check it cannot be obtained.
   */
  verify(token: string): Promise<AuthenticatedPrincipal>;
}
