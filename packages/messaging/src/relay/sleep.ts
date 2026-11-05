/**
 * Waits for a time. Injected so a test can drive the relay loop without real timers.
 * It resolves, and never rejects, when the signal aborts, so an aborted wait ends the wait early.
 */
export type Sleep = (durationMs: number, signal: AbortSignal) => Promise<void>;

/**
 * The real `Sleep`: a timer that an abort signal can cut short.
 *
 * @param durationMs - How long to wait, in milliseconds.
 * @param signal - Aborting it ends the wait at once.
 * @returns Resolves after the duration or as soon as the signal aborts, and leaves no timer behind.
 */
export function sleepUnlessAborted(durationMs: number, signal: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    /** Ends the wait, from the timer or from the abort, and releases both. */
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, durationMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
