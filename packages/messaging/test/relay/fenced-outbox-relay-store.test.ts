import { describe, expect, it } from 'vitest';

import { FencedOutboxRelayStore } from '@/relay/fenced-outbox-relay-store';

import { buildStoredEvent, buildEventId } from '../support/build-event';
import { InMemoryOutboxRelayStore } from '../support/in-memory-outbox-relay-store';

const LEASE_MS = 60_000;
const CLAIM_ID = 'claim-1';

/**
 * @returns A fenced store over an in-memory store that holds one unpublished row.
 */
function buildFencedStore(): { fenced: FencedOutboxRelayStore; inner: InMemoryOutboxRelayStore } {
  const inner = new InMemoryOutboxRelayStore();
  inner.add({ id: buildEventId(1), payload: buildStoredEvent({ id: buildEventId(1) }) });
  return { fenced: new FencedOutboxRelayStore(inner), inner };
}

describe('FencedOutboxRelayStore', () => {
  it('passes every call through to the inner store until it is fenced', async () => {
    const { fenced, inner } = buildFencedStore();

    const claimed = await fenced.claimBatch(CLAIM_ID, 10, LEASE_MS);
    const markedCount = await fenced.markPublished(CLAIM_ID, [buildEventId(1)]);

    expect(claimed.map((row) => row.id)).toEqual([buildEventId(1)]);
    expect(markedCount).toBe(1);
    expect(inner.calls.map((call) => call.method)).toEqual(['claimBatch', 'markPublished']);
  });

  it('claims nothing once it is fenced, and does not ask the inner store', async () => {
    const { fenced, inner } = buildFencedStore();

    fenced.fence();
    const claimed = await fenced.claimBatch(CLAIM_ID, 10, LEASE_MS);

    expect(claimed).toEqual([]);
    expect(inner.calls).toEqual([]);
  });

  it('updates nothing once it is fenced, reports zero rows and does not ask the inner store', async () => {
    const { fenced, inner } = buildFencedStore();
    await fenced.claimBatch(CLAIM_ID, 10, LEASE_MS);

    fenced.fence();
    const results = [
      await fenced.markPublished(CLAIM_ID, [buildEventId(1)]),
      await fenced.recordFailure(CLAIM_ID, buildEventId(1), 1_000),
      await fenced.markFailed(CLAIM_ID, buildEventId(1)),
    ];

    expect(results).toEqual([0, 0, 0]);
    expect(inner.calls.map((call) => call.method)).toEqual(['claimBatch']);
    expect(inner.findRowById(buildEventId(1)).isPublished).toBe(false);
  });

  it('reports that it is fenced only after fence was called', () => {
    const { fenced } = buildFencedStore();

    const before = fenced.isFenced;
    fenced.fence();

    expect({ before, after: fenced.isFenced }).toEqual({ before: false, after: true });
  });

  it('can be fenced twice', () => {
    const { fenced } = buildFencedStore();

    fenced.fence();

    expect(() => {
      fenced.fence();
    }).not.toThrow();
  });
});
