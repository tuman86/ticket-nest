// A broker-less stand-in for amqplib, for unit tests of the topology and the publisher. It records
// what the code under test does, and the test decides when and how each thing ends. It is not
// exported through `./testing`, so it imports production code with the `@/` alias like any test.
import {
  type AmqpChannelLike,
  type AmqpConnect,
  type AmqpConnectionLike,
  type AmqpDeclarationOptions,
  type AmqpPublishProperties,
  type AmqpSocketOptions,
} from '@/relay/amqp-types';

type Listener = (...args: unknown[]) => void;

/** How `close()` of a fake channel or connection ends. */
export type CloseBehaviour = 'resolve' | 'reject' | 'hang';

/** One declaration the code under test made, in call order. */
export type DeclarationCall =
  | {
      readonly method: 'assertExchange';
      readonly exchange: string;
      readonly type: string;
      readonly options: AmqpDeclarationOptions;
    }
  | {
      readonly method: 'assertQueue';
      readonly queue: string;
      readonly options: AmqpDeclarationOptions;
    }
  | {
      readonly method: 'bindQueue';
      readonly queue: string;
      readonly source: string;
      readonly pattern: string;
    };

/** One message handed to `publish`. */
export interface PublishedMessage {
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Buffer;
  readonly options: AmqpPublishProperties;
}

/** Keeps listeners by event name and calls them. */
class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  /**
   * @param event - Event name.
   * @param listener - What to call when the event is emitted.
   */
  add(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  /**
   * @param event - Event name.
   * @param args - Arguments for the listeners.
   * @returns How many listeners were called.
   */
  emit(event: string, ...args: unknown[]): number {
    const listeners = this.listeners.get(event) ?? [];
    listeners.forEach((listener) => {
      listener(...args);
    });
    return listeners.length;
  }
}

/**
 * Ends a close that was scripted.
 *
 * @param behaviour - What `close()` should do.
 * @returns A promise that resolves, rejects or never settles.
 */
function endClose(behaviour: CloseBehaviour): Promise<void> {
  if (behaviour === 'reject') {
    return Promise.reject(new Error('close failed'));
  }
  return behaviour === 'hang' ? new Promise<void>(() => undefined) : Promise.resolve();
}

/** A channel that records declarations and publishes, and ends each as the test says. */
export class FakeAmqpChannel implements AmqpChannelLike {
  /** Every declaration, in call order. */
  readonly declarations: DeclarationCall[] = [];

  /** Every message passed to `publish`, in call order. */
  readonly published: PublishedMessage[] = [];

  /** What `publish` returns. `false` is amqplib's "write buffer full" hint. */
  hasWriteBufferRoom = true;

  /** How `close()` ends. */
  closeBehaviour: CloseBehaviour = 'resolve';

  /** How many times `close()` was called. */
  closeCount = 0;

  /** Called when `close()` starts, so a test can record the order of closes. */
  onClose: (() => void) | undefined;

  private readonly emitter = new Emitter();
  private readonly callbacks: ((error: unknown) => void)[] = [];
  private readonly refusals = new Map<string, Error>();

  /**
   * Makes the next declaration that involves this exchange or queue name fail.
   *
   * @param objectName - The exchange or queue name.
   * @param error - What the declaration rejects with.
   */
  refuseDeclarationOf(objectName: string, error: Error): void {
    this.refusals.set(objectName, error);
  }

  /**
   * Confirms one published message the way the broker does.
   *
   * @param index - Position of the message in `published`.
   */
  acknowledge(index: number): void {
    this.callbackAt(index)(null);
  }

  /**
   * Confirms every published message.
   */
  acknowledgeAll(): void {
    this.callbacks.forEach((callback) => {
      callback(null);
    });
  }

  /**
   * Refuses one published message the way the broker does (a nack).
   *
   * @param index - Position of the message in `published`.
   */
  nack(index: number): void {
    this.callbackAt(index)(new Error('message nacked'));
  }

  /**
   * Ends every message still waiting for a confirm with an error, as amqplib does when a channel
   * closes under them.
   *
   * @param error - What each confirm callback receives.
   */
  failPendingPublishes(error: Error): void {
    this.callbacks.forEach((callback) => {
      callback(error);
    });
  }

  /**
   * Makes the channel report that it closed.
   *
   * @param error - Why it closed, when the broker closed it.
   */
  emitClose(error?: Error): void {
    this.emitter.emit('close', error);
  }

  /**
   * Makes the channel report an error.
   *
   * @param error - The error.
   * @returns How many listeners received it, so a test can prove the code listens at all.
   */
  emitError(error: Error): number {
    return this.emitter.emit('error', error);
  }

  /**
   * Records an exchange declaration and ends it as the test scripted.
   *
   * @param exchange - The exchange name.
   * @param type - The exchange type.
   * @param options - Durability and arguments.
   * @returns Resolves, or rejects when the test made the broker refuse this name.
   */
  assertExchange(
    exchange: string,
    type: string,
    options: AmqpDeclarationOptions,
  ): Promise<unknown> {
    this.declarations.push({ method: 'assertExchange', exchange, type, options });
    return this.settleDeclaration(exchange);
  }

  /**
   * Records a queue declaration and ends it as the test scripted.
   *
   * @param queue - The queue name.
   * @param options - Durability and arguments.
   * @returns Resolves, or rejects when the test made the broker refuse this name.
   */
  assertQueue(queue: string, options: AmqpDeclarationOptions): Promise<unknown> {
    this.declarations.push({ method: 'assertQueue', queue, options });
    return this.settleDeclaration(queue);
  }

  /**
   * Records a binding and ends it as the test scripted.
   *
   * @param queue - The queue to bind.
   * @param source - The exchange to bind it to.
   * @param pattern - The binding key.
   * @returns Resolves, or rejects when the test made the broker refuse this queue name.
   */
  bindQueue(queue: string, source: string, pattern: string): Promise<unknown> {
    this.declarations.push({ method: 'bindQueue', queue, source, pattern });
    return this.settleDeclaration(queue);
  }

  /**
   * Records a message and keeps its confirm callback until the test acks or nacks it.
   *
   * @param exchange - The exchange published to.
   * @param routingKey - The routing key.
   * @param content - The message body.
   * @param options - The message properties.
   * @param callback - Called with the broker's answer.
   * @returns `hasWriteBufferRoom`, like amqplib's `false` for a full write buffer.
   */
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: AmqpPublishProperties,
    callback: (error: unknown) => void,
  ): boolean {
    this.published.push({ exchange, routingKey, content, options });
    this.callbacks.push(callback);
    return this.hasWriteBufferRoom;
  }

  /**
   * @param event - `close` or `error`.
   * @param listener - What to call when the test emits that event.
   * @returns The channel.
   */
  on(event: 'close' | 'error', listener: (error?: Error) => void): this {
    this.emitter.add(event, listener as Listener);
    return this;
  }

  /**
   * Counts the close and ends it as the test scripted.
   *
   * @returns Resolves, rejects or never settles, per `closeBehaviour`.
   */
  close(): Promise<void> {
    this.closeCount += 1;
    this.onClose?.();
    return endClose(this.closeBehaviour);
  }

  /**
   * @param objectName - The exchange or queue the declaration is about.
   * @returns A rejection when the test scripted one for that name, otherwise a resolved promise.
   */
  private settleDeclaration(objectName: string): Promise<unknown> {
    const refusal = this.refusals.get(objectName);
    if (refusal === undefined) {
      return Promise.resolve({});
    }
    this.refusals.delete(objectName);
    return Promise.reject(refusal);
  }

  /**
   * @param index - Position of a published message.
   * @returns The confirm callback of that message.
   * @throws Error when no message was published at that position, which is a mistake in the test.
   */
  private callbackAt(index: number): (error: unknown) => void {
    const callback = this.callbacks[index];
    if (callback === undefined) {
      throw new Error(`No message was published at index ${String(index)}.`);
    }
    return callback;
  }
}

/** A connection that hands out fake channels and reports the events the test makes up. */
export class FakeAmqpConnection implements AmqpConnectionLike {
  /** Channels made by `createChannel`, in order. */
  readonly channels: FakeAmqpChannel[] = [];

  /** Channels made by `createConfirmChannel`, in order. */
  readonly confirmChannels: FakeAmqpChannel[] = [];

  /** How `close()` ends. */
  closeBehaviour: CloseBehaviour = 'resolve';

  /** How many times `close()` was called. */
  closeCount = 0;

  /** When set, `createChannel` and `createConfirmChannel` reject with it. */
  channelError: Error | undefined;

  /** Called when `close()` starts, so a test can record the order of closes. */
  onClose: (() => void) | undefined;

  /**
   * Called with every channel as it is made, before the code under test can use it, so a test can
   * script what the channel will do (for example refuse a declaration).
   */
  prepareChannel: (channel: FakeAmqpChannel) => void = () => undefined;

  private readonly emitter = new Emitter();

  /**
   * Makes the connection report that it closed.
   *
   * @param error - Why it closed, when the broker closed it.
   */
  emitClose(error?: Error): void {
    this.emitter.emit('close', error);
  }

  /**
   * Makes the connection report an error.
   *
   * @param error - The error.
   * @returns How many listeners received it, so a test can prove the code listens at all.
   */
  emitError(error: Error): number {
    return this.emitter.emit('error', error);
  }

  /**
   * Makes the broker report that it blocks this connection.
   *
   * @param reason - The broker's reason, such as `low on memory`.
   */
  emitBlocked(reason: string): void {
    this.emitter.emit('blocked', reason);
  }

  /**
   * Makes the broker report that it no longer blocks this connection.
   */
  emitUnblocked(): void {
    this.emitter.emit('unblocked');
  }

  /**
   * @returns A new fake channel, or a rejection while `channelError` is set.
   */
  createChannel(): Promise<FakeAmqpChannel> {
    return this.openChannel(this.channels);
  }

  /**
   * @returns A new fake confirm channel, or a rejection while `channelError` is set.
   */
  createConfirmChannel(): Promise<FakeAmqpChannel> {
    return this.openChannel(this.confirmChannels);
  }

  /**
   * @param event - `close`, `error`, `blocked` or `unblocked`.
   * @param listener - What to call when the test emits that event.
   * @returns The connection.
   */
  readonly on = ((event: string, listener: Listener): this => {
    this.emitter.add(event, listener);
    return this;
  }) as AmqpConnectionLike['on'];

  /**
   * Counts the close and ends it as the test scripted.
   *
   * @returns Resolves, rejects or never settles, per `closeBehaviour`.
   */
  close(): Promise<void> {
    this.closeCount += 1;
    this.onClose?.();
    return endClose(this.closeBehaviour);
  }

  /**
   * @param into - The list that records channels of this kind.
   * @returns A new channel, or a rejection while `channelError` is set.
   */
  private openChannel(into: FakeAmqpChannel[]): Promise<FakeAmqpChannel> {
    if (this.channelError !== undefined) {
      return Promise.reject(this.channelError);
    }
    const channel = new FakeAmqpChannel();
    this.prepareChannel(channel);
    into.push(channel);
    return Promise.resolve(channel);
  }
}

/** What one call of the fake `connect` was given. */
export interface ConnectCall {
  readonly url: string;
  readonly options: AmqpSocketOptions;
}

/** A connection attempt the test holds open and ends later. */
export interface HeldConnect {
  /** The broker accepts and a connection exists. */
  readonly accept: () => FakeAmqpConnection;
  /** The attempt fails with this error. */
  readonly fail: (error: Error) => void;
}

/** The fake `connect` function, and the connections it made. */
export class FakeAmqpBroker {
  /** Every call of `connect`, in order. */
  readonly connectCalls: ConnectCall[] = [];

  /** Every connection that was opened, in order. */
  readonly connections: FakeAmqpConnection[] = [];

  /** While set, every `connect` rejects with it. */
  connectError: Error | undefined;

  /** Called with every connection as it is made, so a test can script it. */
  prepareConnection: (connection: FakeAmqpConnection) => void = () => undefined;

  private pendingHold: Promise<FakeAmqpConnection> | undefined;

  /** The `connect` function to give the code under test. */
  readonly connect: AmqpConnect = (url, options) => {
    this.connectCalls.push({ url, options });
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    if (this.pendingHold !== undefined) {
      const held = this.pendingHold;
      this.pendingHold = undefined;
      return held;
    }
    return Promise.resolve(this.openConnection());
  };

  /**
   * Holds the next `connect` open until the test accepts or fails it.
   *
   * @returns The handles that end that attempt.
   */
  holdNextConnect(): HeldConnect {
    let resolveHold: (connection: FakeAmqpConnection) => void = () => undefined;
    let rejectHold: (error: Error) => void = () => undefined;
    this.pendingHold = new Promise<FakeAmqpConnection>((resolve, reject) => {
      resolveHold = resolve;
      rejectHold = reject;
    });
    return {
      accept: () => {
        const connection = this.openConnection();
        resolveHold(connection);
        return connection;
      },
      fail: (error) => {
        rejectHold(error);
      },
    };
  }

  /**
   * @returns The connection opened last.
   * @throws Error when none was opened, which is a mistake in the test.
   */
  get latestConnection(): FakeAmqpConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) {
      throw new Error('No connection was opened.');
    }
    return connection;
  }

  /**
   * @returns A new connection that this fake keeps track of.
   */
  private openConnection(): FakeAmqpConnection {
    const connection = new FakeAmqpConnection();
    this.prepareConnection(connection);
    this.connections.push(connection);
    return connection;
  }
}
