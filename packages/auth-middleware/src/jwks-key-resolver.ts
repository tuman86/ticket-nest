import { type KeyObject } from 'node:crypto';

import { type Logger } from '@ticketnest/logger';

import {
  JWKS_CACHE_TTL_MS,
  JWKS_REFETCH_COOLDOWN_MS,
  JWKS_STALE_IF_ERROR_MS,
} from './jwks-constants';
import { type JwksFetcher } from './jwks-fetcher';
import { type KeyResolver, KeySetUnavailableError } from './key-resolver';
import { parseVerificationKeys } from './parse-verification-keys';

export interface JwksKeyResolverOptions {
  readonly fetcher: JwksFetcher;
  readonly logger: Logger;
  /** Clock, replaceable in tests. */
  readonly now?: () => Date;
  /** How long fetched keys are used without asking again. Defaults to `JWKS_CACHE_TTL_MS`. */
  readonly cacheTtlMs?: number;
  /** Shortest time between two fetches. Defaults to `JWKS_REFETCH_COOLDOWN_MS`. */
  readonly refetchCooldownMs?: number;
  /** How long stale keys are used while fetching fails. Defaults to `JWKS_STALE_IF_ERROR_MS`. */
  readonly staleIfErrorMs?: number;
}

/**
 * Resolves verification keys from auth-service's published key set and caches them (ADR-0013).
 *
 * - Keys are used for `cacheTtlMs`, then refetched with the stored `ETag`.
 * - A `kid` that is not cached triggers a refetch, because a key may have just rotated in, but never
 *   more than once per cooldown, so forged ids cannot flood auth-service.
 * - When fetching fails, the last good keys keep working for a bounded time. Past it, and when
 *   nothing is cached, it throws `KeySetUnavailableError` (503).
 * - Concurrent lookups share one fetch. A failed or empty key set never replaces a good one.
 */
export class JwksKeyResolver implements KeyResolver {
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly refetchCooldownMs: number;
  private readonly staleIfErrorMs: number;
  private keys: ReadonlyMap<string, KeyObject> = new Map();
  private etag: string | null = null;
  private fetchedAtMs: number | null = null;
  private lastAttemptAtMs: number | null = null;
  private hasLastAttemptFailed = false;
  private inFlightFetch: Promise<void> | null = null;

  /**
   * @param options - The fetcher and logger, plus optional clock and timing overrides.
   */
  constructor(private readonly options: JwksKeyResolverOptions) {
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? JWKS_CACHE_TTL_MS;
    this.refetchCooldownMs = options.refetchCooldownMs ?? JWKS_REFETCH_COOLDOWN_MS;
    this.staleIfErrorMs = options.staleIfErrorMs ?? JWKS_STALE_IF_ERROR_MS;
  }

  /**
   * Returns the key for a `kid`, fetching the key set first when the cache cannot answer.
   *
   * @param keyId - The `kid` from the token header.
   * @returns The key, or `undefined` when the (current) key set does not contain that `kid`.
   * @throws KeySetUnavailableError when the key set could not be loaded and the answer is not
   * known, or the cached keys are too old to trust.
   */
  async resolveKey(keyId: string): Promise<KeyObject | undefined> {
    const cachedKey = this.keys.get(keyId);
    if (cachedKey !== undefined && this.isFresh()) {
      return cachedKey;
    }
    if (this.inFlightFetch !== null || this.isFetchAllowed()) {
      await this.fetchKeySet();
    }
    return this.answerAfterFetch(keyId);
  }

  /** @returns Whether the cached keys are younger than the cache lifetime. */
  private isFresh(): boolean {
    return this.fetchedAtMs !== null && this.now().getTime() - this.fetchedAtMs < this.cacheTtlMs;
  }

  /** @returns Whether the cooldown since the last fetch attempt has passed. */
  private isFetchAllowed(): boolean {
    return (
      this.lastAttemptAtMs === null ||
      this.now().getTime() - this.lastAttemptAtMs >= this.refetchCooldownMs
    );
  }

  /**
   * Starts a fetch, or joins the one already running. It never rejects: a failure is recorded in
   * `hasLastAttemptFailed` and logged, and `answerAfterFetch` decides what it means.
   *
   * @returns A promise that settles when the fetch is done.
   */
  private fetchKeySet(): Promise<void> {
    this.inFlightFetch ??= this.fetchAndStore().finally(() => {
      this.inFlightFetch = null;
    });
    return this.inFlightFetch;
  }

  /** Fetches the key set and replaces the cache only when the new set is valid. */
  private async fetchAndStore(): Promise<void> {
    const { fetcher, logger } = this.options;
    this.lastAttemptAtMs = this.now().getTime();
    try {
      const result = await fetcher.fetchKeySet(this.etag);
      if (result.status === 'modified') {
        const parsed = parseVerificationKeys(result.document);
        this.keys = parsed.keys;
        this.etag = result.etag;
        if (parsed.skippedKeyCount > 0) {
          logger.warn({ skippedKeyCount: parsed.skippedKeyCount }, 'jwks keys skipped');
        }
      }
      this.fetchedAtMs = this.now().getTime();
      this.hasLastAttemptFailed = false;
    } catch (error) {
      this.hasLastAttemptFailed = true;
      logger.warn({ err: error }, 'jwks fetch failed');
    }
  }

  /**
   * Decides the answer once any fetch is done. When the last fetch failed, a key is trusted only
   * while the cached set is younger than the stale limit, and an unknown `kid` is a 503 (the key
   * may exist in a set that cannot be read), not a 401.
   *
   * @param keyId - The `kid` being resolved.
   * @returns The key, or `undefined` for a `kid` the key set does not contain.
   * @throws KeySetUnavailableError when nothing trustworthy can answer.
   */
  private answerAfterFetch(keyId: string): KeyObject | undefined {
    const key = this.keys.get(keyId);
    if (this.fetchedAtMs === null) {
      throw new KeySetUnavailableError();
    }
    if (!this.hasLastAttemptFailed) {
      return key;
    }
    const keySetAgeMs = this.now().getTime() - this.fetchedAtMs;
    if (key === undefined || keySetAgeMs > this.staleIfErrorMs) {
      throw new KeySetUnavailableError();
    }
    this.options.logger.warn({ keySetAgeMs }, 'jwks served from stale cache');
    return key;
  }
}
