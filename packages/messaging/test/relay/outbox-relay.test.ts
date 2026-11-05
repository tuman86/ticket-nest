import { describe, expect, it, vi } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';
import { OutboxRelay } from '@/relay/outbox-relay';
import { PUBLISH_CONFIRM_TIMEOUT_MS, RELAY_STOP_WAIT_MS } from '@/relay/relay-constants';

import { buildEventId, buildStoredEvent } from '../support/build-event';
import { createTestLogger, type LogLine } from '../support/create-test-logger';
import { FakeEventPublisher } from '../support/fake-event-publisher';
import { FakeRandomSource } from '../support/fake-random-source';
import { FakeSleep } from '../support/fake-sleep';
import { InMemoryOutboxRelayStore } from '../support/in-memory-outbox-relay-store';
import { SequentialIdGenerator } from '../support/sequential-id-generator';
import { settle } from '../support/settle';

const BATCH_SIZE = 2;
const POLL_INTERVAL_MS = 500;
/** With the random source at its highest value the backoff is the upper bound of its window. */
const FIRST_BACKOFF_MS = 1_000;
const SECOND_BACKOFF_MS = 2_000;

/**
 * @returns A relay over fakes, and the fakes themselves. Nothing runs until `start`.
 */
function buildRelay() {
  const store = new InMemoryOutboxRelayStore();
  const publisher = new FakeEventPublisher();
  const fakeSleep = new FakeSleep();
  const { logger, lines } = createTestLogger();
  const relay = new OutboxRelay({
    store,
    publisher,
    idGenerator: new SequentialIdGenerator(),
    randomSource: new FakeRandomSource(1),
    sleep: fakeSleep.sleep,
    logger,
    batchSize: BATCH_SIZE,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  return { relay, store, publisher, fakeSleep, lines };
}

/**
 * @param store - The store to add to.
 * @param sequenceNumber - Makes the event id unique.
 * @returns The event id.
 */
function addRow(store: InMemoryOutboxRelayStore, sequenceNumber: number): string {
  const id = buildEventId(sequenceNumber);
  store.add({ id, payload: buildStoredEvent({ id }) });
  return id;
}

/**
 * @param store - The store whose calls to count.
 * @param method - The method to count.
 * @returns How many times the relay called it.
 */
function countCalls(store: InMemoryOutboxRelayStore, method: string): number {
  return store.calls.filter((call) => call.method === method).length;
}

/**
 * @param lines - Collected log lines.
 * @param message - The message to look for.
 * @returns The lines with that message.
 */
function findLinesWith(lines: readonly LogLine[], message: string): LogLine[] {
  return lines.filter((line) => line.msg === message);
}

describe('OutboxRelay', () => {
  describe('one tick', () => {
    it('connects once on every tick', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();

      relay.start();
      await settle();
      fakeSleep.endOldest();
      await settle();

      expect(publisher.connectCount).toBe(2);
      expect(countCalls(store, 'claimBatch')).toBe(2);
      await relay.stop();
    });

    it('polls again at once after a full batch', async () => {
      const { relay, store, fakeSleep } = buildRelay();
      addRow(store, 1);
      addRow(store, 2);

      relay.start();
      await settle();

      expect(countCalls(store, 'claimBatch')).toBe(2);
      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([POLL_INTERVAL_MS]);
      await relay.stop();
    });

    it('waits the poll interval after a batch that is not full', async () => {
      const { relay, store, fakeSleep } = buildRelay();
      addRow(store, 1);

      relay.start();
      await settle();

      expect(countCalls(store, 'claimBatch')).toBe(1);
      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([POLL_INTERVAL_MS]);
      await relay.stop();
    });

    it('waits the poll interval after an empty batch', async () => {
      const { relay, fakeSleep } = buildRelay();

      relay.start();
      await settle();

      expect(fakeSleep.durations).toEqual([POLL_INTERVAL_MS]);
      await relay.stop();
    });

    it('does not start the next tick while a publish is still in flight', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      const id = addRow(store, 1);
      publisher.hold(id);

      relay.start();
      await settle();
      await settle();

      expect(countCalls(store, 'claimBatch')).toBe(1);
      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([]);
    });

    it('keeps ticking when a publish never settles, because the publish deadline fails the row', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      const id = addRow(store, 1);
      publisher.hold(id);

      relay.start();
      await settle();
      fakeSleep.endSleepOf(PUBLISH_CONFIRM_TIMEOUT_MS);
      await settle();
      fakeSleep.endSleepOf(POLL_INTERVAL_MS);
      await settle();

      expect(store.findRowById(id).attempts).toBe(1);
      expect(countCalls(store, 'claimBatch')).toBe(2);
      await relay.stop();
    });

    it('starts only one loop when start is called twice', async () => {
      const { relay, store } = buildRelay();

      relay.start();
      relay.start();
      await settle();

      expect(countCalls(store, 'claimBatch')).toBe(1);
      await relay.stop();
    });
  });

  describe('a broker that cannot be reached', () => {
    it('claims nothing while it cannot connect, and backs off with growing delays', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      publisher.connectError = new BrokerUnavailableError(new Error('refused'));

      relay.start();
      await settle();
      fakeSleep.endOldest();
      await settle();

      expect(store.calls).toEqual([]);
      expect(fakeSleep.durations).toEqual([FIRST_BACKOFF_MS, SECOND_BACKOFF_MS]);
      await relay.stop();
    });

    it('starts the backoff again from the first step after a successful connect', async () => {
      const { relay, publisher, fakeSleep } = buildRelay();
      publisher.connectError = new BrokerUnavailableError(new Error('refused'));

      relay.start();
      await settle();
      fakeSleep.endOldest();
      await settle();
      publisher.connectError = undefined;
      fakeSleep.endOldest();
      await settle();
      publisher.connectError = new BrokerUnavailableError(new Error('refused again'));
      fakeSleep.endOldest();
      await settle();

      expect(fakeSleep.durations).toEqual([
        FIRST_BACKOFF_MS,
        SECOND_BACKOFF_MS,
        POLL_INTERVAL_MS,
        FIRST_BACKOFF_MS,
      ]);
      await relay.stop();
    });

    it('logs the loss once and the recovery once, not every failed try', async () => {
      const { relay, publisher, fakeSleep, lines } = buildRelay();
      publisher.connectError = new BrokerUnavailableError(new Error('refused'));

      relay.start();
      await settle();
      fakeSleep.endOldest();
      await settle();
      publisher.connectError = undefined;
      fakeSleep.endOldest();
      await settle();

      expect(findLinesWith(lines, 'broker connection lost, backing off')).toHaveLength(1);
      expect(findLinesWith(lines, 'broker connection restored')).toHaveLength(1);
      await relay.stop();
    });

    it('never logs the cause of a broker connection error, because it can hold the broker URL', async () => {
      const { relay, publisher, lines } = buildRelay();
      publisher.connectError = new BrokerUnavailableError(
        new Error('connect failed for amqp://user:secret@broker:5672'),
      );

      relay.start();
      await settle();

      expect(JSON.stringify(lines)).not.toContain('secret');
      await relay.stop();
    });

    it('backs off when a publish finds the broker gone in the middle of a batch', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      const lostId = addRow(store, 1);
      publisher.failWith(lostId, new BrokerUnavailableError(new Error('closed')));

      relay.start();
      await settle();

      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([FIRST_BACKOFF_MS]);
      expect(store.findRowById(lostId)).toMatchObject({ attempts: 0, isPublished: false });
      await relay.stop();
    });
  });

  describe('a tick that fails for another reason', () => {
    it('logs the failure, backs off and keeps going', async () => {
      const { relay, store, fakeSleep, lines } = buildRelay();
      vi.spyOn(store, 'claimBatch').mockRejectedValueOnce(new Error('database down'));

      relay.start();
      await settle();
      fakeSleep.endOldest();
      await settle();

      expect(findLinesWith(lines, 'relay tick failed, backing off')).toHaveLength(1);
      expect(fakeSleep.durations).toEqual([FIRST_BACKOFF_MS, POLL_INTERVAL_MS]);
      expect(countCalls(store, 'claimBatch')).toBe(1);
      await relay.stop();
    });

    it('does not back off for an unexpected error of the publisher on one row', async () => {
      const { relay, store, publisher, fakeSleep, lines } = buildRelay();
      const id = addRow(store, 1);
      publisher.failWith(id, new Error('boom'));

      relay.start();
      await settle();

      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([POLL_INTERVAL_MS]);
      expect(findLinesWith(lines, 'relay tick failed, backing off')).toHaveLength(0);
      await relay.stop();
    });
  });

  describe('stopping', () => {
    it('resolves at once when nothing is in flight, and ends the wait between ticks', async () => {
      const { relay, store, fakeSleep } = buildRelay();
      relay.start();
      await settle();

      await relay.stop();
      await settle();

      expect(countCalls(store, 'claimBatch')).toBe(1);
      expect(fakeSleep.pendingCount).toBe(0);
    });

    it('resolves when it was never started', async () => {
      const { relay, store } = buildRelay();

      await relay.stop();

      expect(store.calls).toEqual([]);
    });

    it('does not start again once it was stopped', async () => {
      const { relay, store, publisher } = buildRelay();
      await relay.stop();

      relay.start();
      await settle();

      expect(publisher.connectCount).toBe(0);
      expect(store.calls).toEqual([]);
    });

    it('waits for the batch in flight and lets it mark its rows', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      const id = addRow(store, 1);
      const held = publisher.hold(id);
      relay.start();
      await settle();

      let isStopped = false;
      const stopping = relay.stop().then(() => {
        isStopped = true;
      });
      await settle();
      expect(isStopped).toBe(false);
      expect(fakeSleep.durationsExcluding(PUBLISH_CONFIRM_TIMEOUT_MS)).toEqual([
        RELAY_STOP_WAIT_MS,
      ]);
      held.release();
      await stopping;

      expect(isStopped).toBe(true);
      expect(store.findRowById(id).isPublished).toBe(true);
    });

    it('gives up after the stop wait, still resolves and logs that a batch was left behind', async () => {
      const { relay, store, publisher, fakeSleep, lines } = buildRelay();
      const id = addRow(store, 1);
      publisher.hold(id);
      relay.start();
      await settle();

      const stopping = relay.stop();
      await settle();
      fakeSleep.endSleepOf(RELAY_STOP_WAIT_MS);
      await stopping;

      expect(findLinesWith(lines, 'relay stopped while a batch was still in flight')).toHaveLength(
        1,
      );
    });

    it('makes no store call after stop has returned, even when a late confirm arrives', async () => {
      const { relay, store, publisher, fakeSleep } = buildRelay();
      const id = addRow(store, 1);
      const held = publisher.hold(id);
      relay.start();
      await settle();
      const stopping = relay.stop();
      await settle();
      fakeSleep.endSleepOf(RELAY_STOP_WAIT_MS);
      await stopping;
      const callsAtStop = store.calls.length;

      held.release();
      await settle();

      expect(store.calls).toHaveLength(callsAtStop);
      expect(store.findRowById(id).isPublished).toBe(false);
    });

    it('does not claim that a claim was lost when a late confirm arrives after stop', async () => {
      const { relay, store, publisher, fakeSleep, lines } = buildRelay();
      const id = addRow(store, 1);
      const held = publisher.hold(id);
      relay.start();
      await settle();
      const stopping = relay.stop();
      await settle();
      fakeSleep.endSleepOf(RELAY_STOP_WAIT_MS);
      await stopping;

      held.release();
      await settle();

      expect(findLinesWith(lines, 'claim was lost before the rows were marked')).toHaveLength(0);
    });

    it('can be called twice', async () => {
      const { relay } = buildRelay();
      relay.start();
      await settle();

      await relay.stop();

      await expect(relay.stop()).resolves.toBeUndefined();
    });
  });
});
