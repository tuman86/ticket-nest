import { type EventEnvelope } from '@ticketnest/contracts';

import { type EventPublisher } from '../../src/event-publisher';

/** Lets a test decide when, and how, one held publish ends. */
export interface HeldPublish {
  /** The broker confirms the event. */
  readonly release: () => void;
  /** The publish fails with this error. */
  readonly fail: (error: Error) => void;
}

/** What the fake does for one event id. Without an entry the event is confirmed at once. */
type Behaviour =
  | { readonly kind: 'reject'; readonly error: Error }
  | { readonly kind: 'hold'; readonly held: Promise<void> };

/**
 * An event publisher with no broker. Every event is confirmed unless the test says otherwise, and
 * the test can make one event fail or hold it until the test lets it go.
 */
export class FakeEventPublisher implements EventPublisher {
  /** Events the fake confirmed, in confirm order. */
  readonly published: EventEnvelope[] = [];

  /** Every event passed to `publish`, in call order, whatever came of it. */
  readonly attempted: EventEnvelope[] = [];

  /** How many times `connect` was called. */
  connectCount = 0;

  /** While set, `connect` rejects with it. */
  connectError: Error | undefined;

  private readonly behaviours = new Map<string, Behaviour>();

  /**
   * Makes the publish of one event fail.
   *
   * @param eventId - The event id.
   * @param error - What `publish` rejects with.
   */
  failWith(eventId: string, error: Error): void {
    this.behaviours.set(eventId, { kind: 'reject', error });
  }

  /**
   * Holds the publish of one event until the test releases or fails it.
   *
   * @param eventId - The event id.
   * @returns The handles that end the held publish.
   */
  hold(eventId: string): HeldPublish {
    let release: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const held = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    this.behaviours.set(eventId, { kind: 'hold', held });
    return { release, fail };
  }

  /**
   * @returns Resolves, or rejects with `connectError` while it is set.
   */
  connect(): Promise<void> {
    this.connectCount += 1;
    return this.connectError === undefined ? Promise.resolve() : Promise.reject(this.connectError);
  }

  /**
   * Records the event and ends as the test scripted: confirmed at once, failed, or held.
   *
   * @param event - The event to publish.
   * @throws Error the error given to `failWith`, or to the `fail` handle of a held publish.
   */
  async publish(event: EventEnvelope): Promise<void> {
    this.attempted.push(event);
    const behaviour = this.behaviours.get(event.id);
    if (behaviour?.kind === 'reject') {
      throw behaviour.error;
    }
    if (behaviour?.kind === 'hold') {
      await behaviour.held;
    }
    this.published.push(event);
  }
}
