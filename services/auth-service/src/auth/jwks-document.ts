/** A key set serialised once, ready to send. */
export interface JwksDocument {
  /** The JSON response body, as bytes, so no charset is added to the media type. */
  readonly body: Buffer;
  /** Strong entity tag: the quoted SHA-256 of `body`. Equal on every replica with the same keys. */
  readonly etag: string;
}
