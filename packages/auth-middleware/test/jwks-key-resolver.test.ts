import { createPublicKey, type KeyObject } from 'node:crypto';

import { createLogger } from '@ticketnest/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JWKS_CACHE_TTL_MS,
  JWKS_REFETCH_COOLDOWN_MS,
  JWKS_STALE_IF_ERROR_MS,
} from '@/jwks-constants';
import { type JwksFetcher, type JwksFetchResult } from '@/jwks-fetcher';
import { JwksKeyResolver } from '@/jwks-key-resolver';
import { KeySetUnavailableError } from '@/key-resolver';

import { TestClock } from './support/test-clock';
import { generateTestSigningKeys } from './support/test-signing-keys';

const KEY_A = 'key-a';
const KEY_B = 'key-b';
/** Margin that keeps "just inside the lifetime" true although `TestClock` follows real time. */
const SAFETY_MARGIN_MS = 1000;

/**
 * @param keyId - The `kid` to publish the key under.
 * @param publicKey - An Ed25519 public key.
 * @returns The key as `/.well-known/jwks.json` publishes it.
 */
function toJwk(keyId: string, publicKey: KeyObject): Record<string, string> {
  const { x } = publicKey.export({ format: 'jwk' });
  return { kty: 'OKP', crv: 'Ed25519', x: x ?? '', use: 'sig', alg: 'EdDSA', kid: keyId };
}

/**
 * @param entries - `[kid, public key]` pairs.
 * @param etag - The `ETag` the server sent.
 * @returns A fetch result carrying a key set with those keys.
 */
function modified(entries: readonly [string, KeyObject][], etag: string | null): JwksFetchResult {
  return {
    status: 'modified',
    document: { keys: entries.map(([keyId, key]) => toJwk(keyId, key)) },
    etag,
  };
}

describe('JwksKeyResolver', () => {
  const publicKeyA = createPublicKey(generateTestSigningKeys().privateKey);
  const publicKeyB = createPublicKey(generateTestSigningKeys().privateKey);
  const logger = createLogger({
    serviceName: 'test',
    level: 'silent',
    nodeEnvironment: 'test',
  });
  let clock: TestClock;
  let fetchKeySet: ReturnType<typeof vi.fn<JwksFetcher['fetchKeySet']>>;
  let resolver: JwksKeyResolver;

  beforeEach(() => {
    clock = new TestClock();
    fetchKeySet = vi.fn<JwksFetcher['fetchKeySet']>();
    resolver = new JwksKeyResolver({ fetcher: { fetchKeySet }, logger, now: clock.now });
  });

  it('fetches the key set on first use and returns the key a kid names', async () => {
    fetchKeySet.mockResolvedValue(modified([[KEY_A, publicKeyA]], '"v1"'));

    const key = await resolver.resolveKey(KEY_A);

    expect(key?.export({ format: 'jwk' })).toEqual(publicKeyA.export({ format: 'jwk' }));
    expect(fetchKeySet).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('serves later lookups from the cache without fetching', async () => {
    fetchKeySet.mockResolvedValue(modified([[KEY_A, publicKeyA]], '"v1"'));

    await resolver.resolveKey(KEY_A);
    clock.advance(JWKS_CACHE_TTL_MS - SAFETY_MARGIN_MS);
    await resolver.resolveKey(KEY_A);

    expect(fetchKeySet).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch between concurrent lookups', async () => {
    fetchKeySet.mockResolvedValue(modified([[KEY_A, publicKeyA]], null));

    await Promise.all([
      resolver.resolveKey(KEY_A),
      resolver.resolveKey(KEY_A),
      resolver.resolveKey(KEY_A),
    ]);

    expect(fetchKeySet).toHaveBeenCalledTimes(1);
  });

  describe('when the cache is older than its lifetime', () => {
    it('refetches with the stored ETag and keeps the keys on 304', async () => {
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_CACHE_TTL_MS);
      fetchKeySet.mockResolvedValueOnce({ status: 'not-modified' });

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeDefined();

      expect(fetchKeySet).toHaveBeenLastCalledWith('"v1"');
      clock.advance(JWKS_CACHE_TTL_MS - SAFETY_MARGIN_MS);
      await resolver.resolveKey(KEY_A);
      expect(fetchKeySet).toHaveBeenCalledTimes(2);
    });

    it('replaces the keys when the set changed, dropping a key that is no longer published', async () => {
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_CACHE_TTL_MS);
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_B, publicKeyB]], '"v2"'));

      await expect(resolver.resolveKey(KEY_B)).resolves.toBeDefined();
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_B, publicKeyB]], '"v2"'));

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeUndefined();
    });
  });

  describe('unknown kid', () => {
    beforeEach(async () => {
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);
    });

    it('refetches once, because the key may have rotated in, and finds the new key', async () => {
      fetchKeySet.mockResolvedValueOnce(
        modified(
          [
            [KEY_A, publicKeyA],
            [KEY_B, publicKeyB],
          ],
          '"v2"',
        ),
      );

      await expect(resolver.resolveKey(KEY_B)).resolves.toBeDefined();

      expect(fetchKeySet).toHaveBeenCalledTimes(2);
    });

    it('does not refetch again inside the cooldown, so a flood of forged kids cannot hammer auth-service', async () => {
      fetchKeySet.mockResolvedValue(modified([[KEY_A, publicKeyA]], '"v1"'));

      await expect(resolver.resolveKey('forged-1')).resolves.toBeUndefined();
      await expect(resolver.resolveKey('forged-2')).resolves.toBeUndefined();
      await expect(resolver.resolveKey('forged-3')).resolves.toBeUndefined();

      expect(fetchKeySet).toHaveBeenCalledTimes(2);
    });

    it('refetches again once the cooldown has passed', async () => {
      fetchKeySet.mockResolvedValue(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey('forged-1');
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);

      await resolver.resolveKey('forged-2');

      expect(fetchKeySet).toHaveBeenCalledTimes(3);
    });

    it('answers 503 and not "unknown key" when the refetch it needed failed', async () => {
      fetchKeySet.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:4001'));

      await expect(resolver.resolveKey(KEY_B)).rejects.toBeInstanceOf(KeySetUnavailableError);
    });
  });

  describe('when auth-service cannot be reached', () => {
    it('answers 503 when there is no cached key set at all', async () => {
      fetchKeySet.mockRejectedValue(new Error('timeout'));

      await expect(resolver.resolveKey(KEY_A)).rejects.toBeInstanceOf(KeySetUnavailableError);
    });

    it('does not retry inside the cooldown after a failure, and answers 503 right away', async () => {
      fetchKeySet.mockRejectedValue(new Error('timeout'));
      await resolver.resolveKey(KEY_A).catch(() => undefined);

      await expect(resolver.resolveKey(KEY_A)).rejects.toBeInstanceOf(KeySetUnavailableError);

      expect(fetchKeySet).toHaveBeenCalledTimes(1);
    });

    it('recovers on the first fetch that works after the cooldown', async () => {
      fetchKeySet.mockRejectedValueOnce(new Error('timeout'));
      await resolver.resolveKey(KEY_A).catch(() => undefined);
      clock.advance(JWKS_REFETCH_COOLDOWN_MS);
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], null));

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeDefined();
    });

    it('keeps serving the stale keys for a bounded time, with a warning', async () => {
      const warn = vi.spyOn(logger, 'warn');
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_CACHE_TTL_MS);
      fetchKeySet.mockRejectedValue(new Error('timeout'));

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeDefined();

      expect(warn).toHaveBeenCalled();
    });

    it('stops serving stale keys once they are older than the stale limit', async () => {
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_STALE_IF_ERROR_MS + 1);
      fetchKeySet.mockRejectedValue(new Error('timeout'));

      await expect(resolver.resolveKey(KEY_A)).rejects.toBeInstanceOf(KeySetUnavailableError);
    });

    it('never puts the driver error in the 503 it throws', async () => {
      fetchKeySet.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:4001'));

      const error: unknown = await resolver.resolveKey(KEY_A).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(KeySetUnavailableError);
      expect((error as KeySetUnavailableError).detail).toBeUndefined();
      expect((error as KeySetUnavailableError).headers['Retry-After']).toBeDefined();
    });
  });

  describe('a key set that cannot be trusted', () => {
    it('counts an empty key set as a failed fetch and keeps the previous keys', async () => {
      fetchKeySet.mockResolvedValueOnce(modified([[KEY_A, publicKeyA]], '"v1"'));
      await resolver.resolveKey(KEY_A);
      clock.advance(JWKS_CACHE_TTL_MS);
      fetchKeySet.mockResolvedValueOnce({
        status: 'modified',
        document: { keys: [] },
        etag: '"v2"',
      });

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeDefined();
    });

    it('counts a document that is not a key set as a failed fetch', async () => {
      fetchKeySet.mockResolvedValue({
        status: 'modified',
        document: '<html>bad gateway</html>',
        etag: null,
      });

      await expect(resolver.resolveKey(KEY_A)).rejects.toBeInstanceOf(KeySetUnavailableError);
    });

    it('skips a key it cannot use (another type or algorithm) and keeps the rest', async () => {
      fetchKeySet.mockResolvedValue({
        status: 'modified',
        document: {
          keys: [
            { kty: 'RSA', n: 'abc', e: 'AQAB', use: 'sig', alg: 'RS256', kid: 'rsa-key' },
            toJwk(KEY_A, publicKeyA),
          ],
        },
        etag: null,
      });

      await expect(resolver.resolveKey(KEY_A)).resolves.toBeDefined();
      await expect(resolver.resolveKey('rsa-key')).resolves.toBeUndefined();
    });

    it('refuses a key that carries a private member', async () => {
      fetchKeySet.mockResolvedValue({
        status: 'modified',
        document: { keys: [{ ...toJwk(KEY_A, publicKeyA), d: 'private-part' }] },
        etag: null,
      });

      await expect(resolver.resolveKey(KEY_A)).rejects.toBeInstanceOf(KeySetUnavailableError);
    });
  });
});
