import { describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { type IdGenerator } from '@/id-generator';
import { PublishNotConfirmedError } from '@/publish-not-confirmed.error';
import { calculateBackoffMs } from '@/relay/calculate-backoff';
import { OutboxBatchProcessor } from '@/relay/outbox-batch-processor';
import { CLAIM_LEASE_MS, MAX_ATTEMPTS, PUBLISH_CONFIRM_TIMEOUT_MS } from '@/relay/relay-constants';

import {
  buildEventId,
  buildStoredEvent,
  EVENT_CORRELATION_ID,
  USER_ID,
} from '../support/build-event';
import { createTestLogger, type LogLine } from '../support/create-test-logger';
import { FakeEventPublisher } from '../support/fake-event-publisher';
import { FakeRandomSource } from '../support/fake-random-source';
import { FakeSleep } from '../support/fake-sleep';
import { InMemoryOutboxRelayStore } from '../support/in-memory-outbox-relay-store';
import { settle } from '../support/settle';

const BATCH_SIZE = 50;
const HIGHEST_RANDOM = 1;
const FIRST_CLAIM_ID = 'claim-1';
const SECOND_CLAIM_ID = 'claim-2';

/**
 * Claim ids that can never be mistaken for event ids, so a test notices when one is passed where the
 * other belongs.
 *
 * @returns A generator that returns `claim-1`, `claim-2` and so on.
 */
function buildClaimIdGenerator(): IdGenerator {
  let nextNumber = 1;
  return {
    generate: () => {
      const claimId = `claim-${String(nextNumber)}`;
      nextNumber += 1;
      return claimId;
    },
  };
}

/**
 * @param batchSize - The most rows one batch claims.
 * @returns A processor over fakes, and the fakes themselves.
 */
function buildProcessor(batchSize = BATCH_SIZE) {
  const store = new InMemoryOutboxRelayStore();
  const publisher = new FakeEventPublisher();
  const fakeSleep = new FakeSleep();
  const { logger, lines } = createTestLogger();
  const processor = new OutboxBatchProcessor({
    store,
    publisher,
    idGenerator: buildClaimIdGenerator(),
    randomSource: new FakeRandomSource(HIGHEST_RANDOM),
    sleep: fakeSleep.sleep,
    logger,
    batchSize,
    isStoreFenced: () => false,
  });
  return { processor, store, publisher, fakeSleep, lines };
}

/**
 * Adds a valid unpublished row.
 *
 * @param store - The store to add to.
 * @param sequenceNumber - Makes the event id unique.
 * @param attempts - How many failures the row already has.
 * @returns The event id.
 */
function addRow(store: InMemoryOutboxRelayStore, sequenceNumber: number, attempts = 0): string {
  const id = buildEventId(sequenceNumber);
  store.add({ id, attempts, payload: buildStoredEvent({ id }) });
  return id;
}

/**
 * @param lines - Collected log lines.
 * @param level - The level to look for.
 * @returns The lines at that level.
 */
function findLinesAt(lines: readonly LogLine[], level: string): LogLine[] {
  return lines.filter((line) => line.level === level);
}

describe('OutboxBatchProcessor', () => {
  describe('claiming', () => {
    it('claims with a fresh claim id, the batch size and the lease', async () => {
      const { processor, store } = buildProcessor(3);

      await processor.run();

      expect(store.calls[0]).toEqual({
        method: 'claimBatch',
        claimId: FIRST_CLAIM_ID,
        ids: [],
        limit: 3,
        leaseMs: CLAIM_LEASE_MS,
      });
    });

    it('uses a new claim id for every batch', async () => {
      const { processor, store } = buildProcessor();

      await processor.run();
      await processor.run();

      expect(store.calls.map((call) => call.claimId)).toEqual([FIRST_CLAIM_ID, SECOND_CLAIM_ID]);
    });

    it('reports how many rows it claimed', async () => {
      const { processor, store } = buildProcessor();
      addRow(store, 1);
      addRow(store, 2);

      const result = await processor.run();

      expect(result).toEqual({ claimedCount: 2, isConnectionLost: false });
    });

    it('does nothing else when the batch is empty', async () => {
      const { processor, store, publisher } = buildProcessor();

      const result = await processor.run();

      expect(result).toEqual({ claimedCount: 0, isConnectionLost: false });
      expect(store.calls.map((call) => call.method)).toEqual(['claimBatch']);
      expect(publisher.attempted).toEqual([]);
    });
  });

  describe('publishing', () => {
    it('starts publishing the rows in the order the store returned them', async () => {
      const { processor, store, publisher } = buildProcessor();
      const ids = [addRow(store, 1), addRow(store, 2), addRow(store, 3)];

      await processor.run();

      expect(publisher.attempted.map((event) => event.id)).toEqual(ids);
    });

    it('marks every confirmed row in one call', async () => {
      const { processor, store } = buildProcessor();
      const ids = [addRow(store, 1), addRow(store, 2), addRow(store, 3)];

      await processor.run();

      const marks = store.calls.filter((call) => call.method === 'markPublished');
      expect(marks).toHaveLength(1);
      expect(marks[0]?.ids).toEqual(ids);
      expect(store.rows.every((row) => row.isPublished)).toBe(true);
    });

    it('adds the claim id to every update it makes', async () => {
      const { processor, store, publisher } = buildProcessor();
      addRow(store, 1);
      const failingId = addRow(store, 2);
      publisher.failWith(failingId, new PublishNotConfirmedError('nack'));

      await processor.run();

      expect(store.calls.map((call) => call.claimId)).toEqual([
        FIRST_CLAIM_ID,
        FIRST_CLAIM_ID,
        FIRST_CLAIM_ID,
      ]);
    });

    it('passes the claim id to the update that ends a row after its last attempt', async () => {
      const { processor, store, publisher } = buildProcessor();
      const id = addRow(store, 1, MAX_ATTEMPTS - 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      const ending = store.calls.find((call) => call.method === 'markFailed');
      expect(ending).toMatchObject({ claimId: FIRST_CLAIM_ID, ids: [id] });
    });

    it('passes the claim id to the update that ends a row with an invalid payload', async () => {
      const { processor, store } = buildProcessor();
      const id = buildEventId(1);
      store.add({ id, payload: 'garbage' });

      await processor.run();

      const ending = store.calls.find((call) => call.method === 'markFailed');
      expect(ending).toMatchObject({ claimId: FIRST_CLAIM_ID, ids: [id] });
    });
  });

  describe('the publish deadline', () => {
    it('fails a row whose publish never settles as unconfirmed, once the deadline passes', async () => {
      const { processor, store, publisher, fakeSleep, lines } = buildProcessor();
      const id = addRow(store, 1);
      publisher.hold(id);

      const running = processor.run();
      await settle();
      expect(fakeSleep.durations).toEqual([PUBLISH_CONFIRM_TIMEOUT_MS]);
      fakeSleep.endOldest();
      await running;

      expect(store.findRowById(id)).toMatchObject({ attempts: 1, isPublished: false });
      expect(findLinesAt(lines, 'warn')[0]).toMatchObject({
        eventId: id,
        reason: 'confirm_timeout',
      });
    });

    it('still marks the other rows of the batch when one row times out', async () => {
      const { processor, store, publisher, fakeSleep } = buildProcessor();
      const goodId = addRow(store, 1);
      const stuckId = addRow(store, 2);
      publisher.hold(stuckId);

      const running = processor.run();
      await settle();
      fakeSleep.endSleepOf(PUBLISH_CONFIRM_TIMEOUT_MS);
      await running;

      expect(store.findRowById(goodId).isPublished).toBe(true);
      expect(store.findRowById(stuckId).isPublished).toBe(false);
    });

    it('leaves no timer behind when every publish settles in time', async () => {
      const { processor, store, fakeSleep } = buildProcessor();
      addRow(store, 1);
      addRow(store, 2);

      await processor.run();

      expect(fakeSleep.pendingCount).toBe(0);
    });

    it('ignores a failure of the abandoned publish that arrives after the deadline', async () => {
      const { processor, store, publisher, fakeSleep } = buildProcessor();
      const id = addRow(store, 1);
      const held = publisher.hold(id);
      const running = processor.run();
      await settle();
      fakeSleep.endOldest();
      await running;

      held.fail(new Error('arrived too late'));
      await settle();

      expect(store.findRowById(id).attempts).toBe(1);
    });
  });

  describe('a row the broker did not confirm', () => {
    it('charges one attempt and sets a backoff, and leaves the row unpublished', async () => {
      const { processor, store, publisher } = buildProcessor();
      const id = addRow(store, 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      const failure = store.calls.find((call) => call.method === 'recordFailure');
      const expectedBackoff = calculateBackoffMs(1, new FakeRandomSource(HIGHEST_RANDOM));
      expect(failure).toMatchObject({ ids: [id], retryAfterMs: expectedBackoff });
      expect(store.findRowById(id)).toMatchObject({
        attempts: 1,
        isPublished: false,
        isFailed: false,
      });
    });

    it('retries a row on its ninth failure, with the backoff of the ninth failure', async () => {
      const { processor, store, publisher } = buildProcessor();
      const id = addRow(store, 1, MAX_ATTEMPTS - 2);
      publisher.failWith(id, new PublishNotConfirmedError('confirm_timeout'));

      await processor.run();

      const failure = store.calls.find((call) => call.method === 'recordFailure');
      const expectedBackoff = calculateBackoffMs(
        MAX_ATTEMPTS - 1,
        new FakeRandomSource(HIGHEST_RANDOM),
      );
      expect(failure?.retryAfterMs).toBe(expectedBackoff);
      expect(store.findRowById(id)).toMatchObject({ attempts: MAX_ATTEMPTS - 1, isFailed: false });
    });

    it('gives up on a row at its tenth failure', async () => {
      const { processor, store, publisher } = buildProcessor();
      const id = addRow(store, 1, MAX_ATTEMPTS - 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      expect(store.calls.some((call) => call.method === 'recordFailure')).toBe(false);
      expect(store.calls.find((call) => call.method === 'markFailed')).toMatchObject({
        ids: [id],
      });
      expect(store.findRowById(id).isFailed).toBe(true);
    });

    it('publishes and marks the other rows of the same batch', async () => {
      const { processor, store, publisher } = buildProcessor();
      const goodIds = [addRow(store, 1), addRow(store, 3)];
      const badId = addRow(store, 2);
      publisher.failWith(badId, new PublishNotConfirmedError('nack'));

      await processor.run();

      const marks = store.calls.filter((call) => call.method === 'markPublished');
      expect(marks[0]?.ids).toEqual(goodIds);
      expect(store.findRowById(badId).isPublished).toBe(false);
    });
  });

  describe('a payload that is not a valid event', () => {
    it('gives up on the row at once and never publishes it', async () => {
      const { processor, store, publisher } = buildProcessor();
      const id = buildEventId(1);
      store.add({ id, payload: { not: 'an event' } });

      await processor.run();

      expect(publisher.attempted).toEqual([]);
      expect(store.calls.find((call) => call.method === 'markFailed')).toMatchObject({
        ids: [id],
      });
      expect(store.findRowById(id).isFailed).toBe(true);
    });

    it('still publishes the valid rows of the same batch', async () => {
      const { processor, store, publisher } = buildProcessor();
      store.add({ id: buildEventId(1), payload: 'garbage' });
      const goodId = addRow(store, 2);

      await processor.run();

      expect(publisher.published.map((event) => event.id)).toEqual([goodId]);
      expect(store.findRowById(goodId).isPublished).toBe(true);
    });
  });

  describe('a broker that cannot be reached', () => {
    it('leaves that row alone, marks the confirmed rows and reports the lost connection', async () => {
      const { processor, store, publisher } = buildProcessor();
      const goodIds = [addRow(store, 1), addRow(store, 3)];
      const lostId = addRow(store, 2);
      publisher.failWith(lostId, new BrokerUnavailableError(new Error('closed')));

      const result = await processor.run();

      expect(result).toEqual({ claimedCount: 3, isConnectionLost: true });
      const marks = store.calls.filter((call) => call.method === 'markPublished');
      expect(marks[0]?.ids).toEqual(goodIds);
      expect(store.calls.some((call) => call.method === 'recordFailure')).toBe(false);
      expect(store.calls.some((call) => call.method === 'markFailed')).toBe(false);
      expect(store.findRowById(lostId)).toMatchObject({ attempts: 0, isPublished: false });
    });
  });

  describe('an unexpected error from the publisher', () => {
    it('logs it for its row, leaves the row alone, marks the others and does not throw', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const goodId = addRow(store, 1);
      const brokenId = addRow(store, 2);
      publisher.failWith(brokenId, new Error('boom, the payload said hush'));

      const result = await processor.run();

      expect(result).toEqual({ claimedCount: 2, isConnectionLost: false });
      expect(store.findRowById(goodId).isPublished).toBe(true);
      expect(store.findRowById(brokenId)).toMatchObject({ attempts: 0, isPublished: false });
      const [line] = findLinesAt(lines, 'error');
      expect(line).toMatchObject({
        eventId: brokenId,
        type: 'user.registered',
        errorName: 'Error',
      });
      expect(JSON.stringify(line)).not.toContain('hush');
    });
  });

  describe('an error from the store itself', () => {
    it('rethrows it after marking the confirmed rows', async () => {
      const { processor, store, publisher } = buildProcessor();
      const goodId = addRow(store, 1);
      const nackedId = addRow(store, 2);
      publisher.failWith(nackedId, new PublishNotConfirmedError('nack'));
      vi.spyOn(store, 'recordFailure').mockRejectedValueOnce(new Error('database down'));

      await expect(processor.run()).rejects.toThrow('database down');

      expect(store.findRowById(goodId).isPublished).toBe(true);
    });
  });

  describe('a claim that was lost', () => {
    it('does not mark a row another claim has taken, and warns', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const id = addRow(store, 1);
      const held = publisher.hold(id);

      const running = processor.run();
      await settle();
      store.advanceTime(CLAIM_LEASE_MS + 1);
      await store.claimBatch('another-replica', BATCH_SIZE, CLAIM_LEASE_MS);
      held.release();
      await running;

      expect(store.findRowById(id)).toMatchObject({
        isPublished: false,
        lockedBy: 'another-replica',
      });
      expect(findLinesAt(lines, 'warn')).toContainEqual(
        expect.objectContaining({ msg: 'claim was lost before the rows were marked' }),
      );
    });

    it('does not charge an attempt to a row another claim has taken, and warns', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const id = addRow(store, 1);
      const held = publisher.hold(id);

      const running = processor.run();
      await settle();
      store.advanceTime(CLAIM_LEASE_MS + 1);
      await store.claimBatch('another-replica', BATCH_SIZE, CLAIM_LEASE_MS);
      held.fail(new PublishNotConfirmedError('nack'));
      await running;

      expect(store.findRowById(id)).toMatchObject({ attempts: 0, lockedBy: 'another-replica' });
      expect(findLinesAt(lines, 'warn')).toContainEqual(
        expect.objectContaining({ msg: 'claim was lost before the failure was recorded' }),
      );
    });
  });

  describe('logging', () => {
    it('logs a failed row with its id, type, new attempt count and reason, but not its content', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const id = addRow(store, 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      const [line] = findLinesAt(lines, 'warn');
      expect(line).toMatchObject({
        eventId: id,
        type: 'user.registered',
        attempts: 1,
        reason: 'nack',
      });
      expect(JSON.stringify(line)).not.toContain('CUSTOMER');
      expect(JSON.stringify(line)).not.toContain(USER_ID);
    });

    it('puts the correlation id of the event on the log lines of its row', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const id = addRow(store, 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      expect(findLinesAt(lines, 'warn')[0]).toMatchObject({ correlationId: EVENT_CORRELATION_ID });
    });

    it('logs at error level when a row reaches its last attempt', async () => {
      const { processor, store, publisher, lines } = buildProcessor();
      const id = addRow(store, 1, MAX_ATTEMPTS - 1);
      publisher.failWith(id, new PublishNotConfirmedError('nack'));

      await processor.run();

      expect(findLinesAt(lines, 'error')[0]).toMatchObject({
        eventId: id,
        attempts: MAX_ATTEMPTS,
        msg: 'event gave up after its last attempt',
      });
    });

    it('logs a payload that is not an event at error level with the failed fields only, under a correlation id of the batch', async () => {
      const { processor, store, lines } = buildProcessor();
      const id = buildEventId(1);
      store.add({ id, payload: buildStoredEvent({ correlationId: '', data: { secret: 'hush' } }) });

      await processor.run();

      const [line] = findLinesAt(lines, 'error');
      expect(line).toMatchObject({ eventId: id, failedFields: ['correlationId'] });
      expect(typeof line?.correlationId).toBe('string');
      expect(JSON.stringify(line)).not.toContain('hush');
    });
  });
});
