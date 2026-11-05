// The parts of an AMQP client the relay uses, written as plain structural types so that only
// `AmqpEventPublisher` imports amqplib (ADR-0007) and everything else, tests included, can run
// against a fake. amqplib's own channel and connection satisfy them.

/** Options of an exchange or queue declaration. */
export interface AmqpDeclarationOptions {
  readonly durable: boolean;
  /** Broker arguments such as `alternate-exchange` or `x-message-ttl`. */
  readonly arguments?: Readonly<Record<string, unknown>>;
}

/** The message properties ADR-0005 sets on every published event, and no others. */
export interface AmqpPublishProperties {
  /** Delivery mode 2: the broker writes the message to disk. */
  readonly persistent: boolean;
  readonly contentType: string;
  /** The event id. */
  readonly messageId: string;
  /** The event type. */
  readonly type: string;
  readonly correlationId: string;
}

/** The channel operations the relay uses. */
export interface AmqpChannelLike {
  assertExchange: (
    exchange: string,
    type: string,
    options: AmqpDeclarationOptions,
  ) => Promise<unknown>;
  assertQueue: (queue: string, options: AmqpDeclarationOptions) => Promise<unknown>;
  bindQueue: (queue: string, source: string, pattern: string) => Promise<unknown>;
  /**
   * Publishes on a confirm channel.
   *
   * @returns `false` when amqplib's write buffer is full. The publisher ignores it (it queues the
   * message either way, and the batch size bounds the memory).
   */
  publish: (
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: AmqpPublishProperties,
    callback: (error: unknown) => void,
  ) => boolean;
  on: (event: 'close' | 'error', listener: (error?: Error) => void) => unknown;
  close: () => Promise<void>;
}

/** The connection operations the relay uses. */
export interface AmqpConnectionLike {
  createChannel: () => Promise<AmqpChannelLike>;
  createConfirmChannel: () => Promise<AmqpChannelLike>;
  on: {
    (event: 'close', listener: (error?: Error) => void): unknown;
    (event: 'error', listener: (error: Error) => void): unknown;
    (event: 'blocked', listener: (reason: string) => void): unknown;
    (event: 'unblocked', listener: () => void): unknown;
  };
  close: () => Promise<void>;
}

/** Socket options the publisher passes to the AMQP client. */
export interface AmqpSocketOptions {
  /** How long opening the TCP connection may take, in milliseconds. */
  readonly timeout: number;
}

/** Opens a connection. The publisher takes one so a test can hand it a fake. */
export type AmqpConnect = (url: string, options: AmqpSocketOptions) => Promise<AmqpConnectionLike>;
