import { PublishNotConfirmedError } from '../publish-not-confirmed.error';

/**
 * One publish that has been sent and waits for the broker's confirm. It settles exactly once,
 * whichever comes first: the confirm, a failure, or the deadline. It then clears its timer and
 * tells its owner, and ignores anything that arrives later (a late ack after a timeout, for
 * example).
 */
export class PendingPublish {
  /** Resolves on the confirm and rejects on any failure. */
  readonly promise: Promise<void>;

  private isSettled = false;
  private resolvePromise: () => void = () => undefined;
  private rejectPromise: (error: Error) => void = () => undefined;
  private readonly timer: ReturnType<typeof setTimeout>;

  /**
   * @param timeoutMs - How long the broker has to confirm, in milliseconds. Past it the publish
   * rejects with `PublishNotConfirmedError('confirm_timeout')`.
   * @param onSettled - Called once, when the publish has settled, so its owner can forget it.
   */
  constructor(
    timeoutMs: number,
    private readonly onSettled: (pending: PendingPublish) => void,
  ) {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    this.timer = setTimeout(() => {
      this.fail(new PublishNotConfirmedError('confirm_timeout'));
    }, timeoutMs);
  }

  /**
   * Settles the publish as confirmed. Does nothing once it has settled.
   */
  confirm(): void {
    this.settle(this.resolvePromise);
  }

  /**
   * Settles the publish as failed. Does nothing once it has settled.
   *
   * @param error - What the publish rejects with.
   */
  fail(error: Error): void {
    this.settle(() => {
      this.rejectPromise(error);
    });
  }

  /**
   * @param outcome - Resolves or rejects the promise.
   */
  private settle(outcome: () => void): void {
    if (this.isSettled) {
      return;
    }
    this.isSettled = true;
    clearTimeout(this.timer);
    outcome();
    this.onSettled(this);
  }
}
