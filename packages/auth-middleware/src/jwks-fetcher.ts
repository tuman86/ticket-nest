/** The key set did not change since the version the caller already holds (HTTP 304). */
export interface JwksNotModified {
  readonly status: 'not-modified';
}

/** A new key set. `document` is untrusted JSON: the caller validates it. */
export interface JwksModified {
  readonly status: 'modified';
  readonly document: unknown;
  /** The version tag to send back on the next fetch, or `null` when the server sent none. */
  readonly etag: string | null;
}

export type JwksFetchResult = JwksNotModified | JwksModified;

/**
 * Gets the published key set from auth-service. An interface so the resolver's caching rules are
 * tested without a network, and only the composition root names the HTTP implementation.
 */
export interface JwksFetcher {
  /**
   * Fetches the key set, conditionally when the caller holds a version of it.
   *
   * @param previousEtag - The `ETag` of the key set the caller holds, or `null` when it has none.
   * @returns The new key set, or `not-modified`.
   * @throws Error when the key set could not be fetched (network failure, timeout, bad status,
   * unreadable or oversized body). The resolver turns it into a log line and a fallback.
   */
  fetchKeySet(previousEtag: string | null): Promise<JwksFetchResult>;
}
