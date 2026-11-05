import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sleepUnlessAborted } from '@/relay/sleep';

describe('sleepUnlessAborted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once the duration has passed', async () => {
    let isDone = false;
    const sleeping = sleepUnlessAborted(1_000, new AbortController().signal).then(() => {
      isDone = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(isDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;

    expect(isDone).toBe(true);
  });

  it('resolves at once when the signal is already aborted, without leaving a timer', async () => {
    const controller = new AbortController();
    controller.abort();

    await sleepUnlessAborted(60_000, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves early when the signal aborts and clears its timer', async () => {
    const controller = new AbortController();
    const sleeping = sleepUnlessAborted(60_000, controller.signal);

    controller.abort();
    await sleeping;

    expect(vi.getTimerCount()).toBe(0);
  });
});
