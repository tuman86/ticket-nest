/**
 * Lets every promise that can make progress without a timer do so: it waits one turn of the event
 * loop, after all pending microtasks have run. Used to reach the point where the relay is parked on
 * a held publish or on a fake sleep.
 *
 * @returns Resolves after one turn of the event loop.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
