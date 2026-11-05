import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PublishNotConfirmedError } from '@/publish-not-confirmed.error';
import { PendingPublish } from '@/relay/pending-publish';

const TIMEOUT_MS = 10_000;

/**
 * @param promise - A promise that is expected to reject.
 * @returns What it rejected with, or `undefined` when it resolved.
 */
function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('PendingPublish', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when it is confirmed', async () => {
    const pending = new PendingPublish(TIMEOUT_MS, () => undefined);

    pending.confirm();

    await expect(pending.promise).resolves.toBeUndefined();
  });

  it('rejects with the error it is failed with', async () => {
    const pending = new PendingPublish(TIMEOUT_MS, () => undefined);
    const failure = new Error('connection lost');

    pending.fail(failure);

    expect(await captureRejection(pending.promise)).toBe(failure);
  });

  it("rejects with PublishNotConfirmedError('confirm_timeout') when the deadline passes", async () => {
    const pending = new PendingPublish(TIMEOUT_MS, () => undefined);
    const outcome = captureRejection(pending.promise);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    const error = await outcome;
    expect(error).toBeInstanceOf(PublishNotConfirmedError);
    expect(error).toMatchObject({ reason: 'confirm_timeout' });
  });

  it('settles once: a confirm after a failure, or a failure after a confirm, changes nothing', async () => {
    const failed = new PendingPublish(TIMEOUT_MS, () => undefined);
    const confirmed = new PendingPublish(TIMEOUT_MS, () => undefined);
    const failure = new Error('first');

    failed.fail(failure);
    failed.confirm();
    confirmed.confirm();
    confirmed.fail(new Error('second'));

    expect(await captureRejection(failed.promise)).toBe(failure);
    await expect(confirmed.promise).resolves.toBeUndefined();
  });

  it('tells its owner once, with itself, however many times it is settled', () => {
    const onSettled = vi.fn();
    const pending = new PendingPublish(TIMEOUT_MS, onSettled);
    void captureRejection(pending.promise);

    pending.fail(new Error('lost'));
    pending.confirm();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(pending);
  });

  it('clears its timer once it has settled', () => {
    const pending = new PendingPublish(TIMEOUT_MS, () => undefined);

    pending.confirm();

    expect(vi.getTimerCount()).toBe(0);
  });
});
