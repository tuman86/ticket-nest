import {
  type AccessTokenVerifier,
  HttpJwksFetcher,
  JwksKeyResolver,
  JwtAccessTokenVerifier,
} from '@ticketnest/auth-middleware';
import { type Logger } from '@ticketnest/logger';

export interface JwksAccessTokenVerifierOptions {
  /** Full URL of auth-service's key set (`<origin>/.well-known/jwks.json`). */
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly logger: Logger;
}

/**
 * Builds the verifier the gateway uses. The gateway holds no key: it fetches auth-service's public
 * keys, caches them, and refetches (with a cooldown) when it sees an unknown `kid`, so a key
 * rotation needs no gateway restart (docs/runbooks/jwt-key-rotation.md).
 *
 * @param options - Where to fetch the keys, what `iss` and `aud` to require, and a logger.
 * @returns A verifier for access tokens signed by auth-service.
 */
export function createJwksAccessTokenVerifier(
  options: JwksAccessTokenVerifierOptions,
): AccessTokenVerifier {
  return new JwtAccessTokenVerifier({
    keyResolver: new JwksKeyResolver({
      fetcher: new HttpJwksFetcher({ url: options.jwksUrl }),
      logger: options.logger,
    }),
    issuer: options.issuer,
    audience: options.audience,
  });
}
