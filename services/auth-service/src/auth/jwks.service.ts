import { createHash } from 'node:crypto';

import { Jwks, type Jwk } from '@ticketnest/contracts';

import { type JwksDocument } from './jwks-document';

/**
 * Serves the public key set. It is built once, when the service starts: the keys never change
 * while the process runs (rotation is a config change and a restart), so nothing is recomputed
 * per request. It receives public JWKs only, so it can never see the private key.
 */
export class JwksService {
  private readonly document: JwksDocument;

  /**
   * @param publicKeys - The public JWKs to publish, signing key first.
   * @throws ZodError when the set is empty or any key has a member the `Jwk` contract forbids,
   *   such as a private member. The error names the member, never its value.
   */
  constructor(publicKeys: readonly Jwk[]) {
    const jwks = Jwks.parse({ keys: publicKeys });
    const body = Buffer.from(JSON.stringify(jwks), 'utf8');
    const digest = createHash('sha256').update(body).digest('base64url');
    this.document = Object.freeze({ body, etag: `"${digest}"` });
  }

  /**
   * @returns The same prebuilt document on every call: the exact response bytes and their strong ETag.
   */
  getDocument(): JwksDocument {
    return this.document;
  }
}
