import { type EventEnvelope } from '@ticketnest/contracts';
import { type Logger } from '@ticketnest/logger';
import { connect as connectWithAmqplib } from 'amqplib';

import { BrokerUnavailableError } from '../broker-unavailable.error';
import { type EventPublisher } from '../event-publisher';
import { PublishNotConfirmedError } from '../publish-not-confirmed.error';
import { buildEventExchangeName } from '../topology-names';

import { declareEventTopology } from './amqp-topology';
import { type AmqpChannelLike, type AmqpConnect, type AmqpConnectionLike } from './amqp-types';
import { buildPublishOptions } from './build-publish-options';
import { InvalidBrokerUrlError } from './invalid-broker-url.error';
import { PendingPublish } from './pending-publish';
import { readReplyCode } from './read-reply-code';
import {
  AMQP_CLOSE_TIMEOUT_MS,
  AMQP_CONNECT_TIMEOUT_MS,
  AMQP_HEARTBEAT_SECONDS,
  PUBLISH_CONFIRM_TIMEOUT_MS,
} from './relay-constants';
import { TopologyDeclarationError } from './topology-declaration.error';

/**
 * What amqplib 2.2.0 (pinned exactly in the catalog) puts in the error it hands to the confirm
 * callback of a nacked publish. A callback error without it means the channel closed under the
 * publish, which is a lost connection and charges no attempt.
 */
const NACK_ERROR_MESSAGE = 'message nacked';

const BLOCKED_REASON = 'The broker is blocking the connection.';
const CLOSED_REASON = 'The publisher is closed.';
const NOT_CONNECTED_REASON = 'The publisher is not connected.';
const LOST_WHILE_OPENING_REASON = 'The connection was lost while it was opening.';

/** What the publisher needs from its surroundings. */
export interface AmqpEventPublisherDependencies {
  /** The broker URL, `amqp` or `amqps`, with credentials and the vhost in the path. Never logged. */
  readonly url: string;
  /** The producing domain (`auth`). Every event goes to that domain's exchange (ADR-0005). */
  readonly domain: string;
  readonly logger: Logger;
  /** Opens a connection. Defaults to amqplib's `connect`; tests pass a fake. */
  readonly connect?: AmqpConnect;
}

/** One connection to the broker, from the moment it opens until it is lost or closed. */
interface Session {
  readonly connection: AmqpConnectionLike;
  /** The confirm channel events are published on. Set once the topology is declared. */
  channel: AmqpChannelLike | undefined;
  /** Set when the broker blocks the connection (memory or disk alarm). */
  isBlocked: boolean;
  /** Set once the session ended, so the several events of one loss are handled once. */
  isLost: boolean;
  /** Publishes sent on this session and not yet settled. */
  readonly pending: Set<PendingPublish>;
}

/**
 * @param error - Whatever an AMQP operation rejected with.
 * @returns Fields safe to log: the error's name and its reply code, never its message, because a
 * driver message can carry the broker URL and its password.
 */
function describeErrorForLog(error: unknown): { errorName: string; replyCode?: number } {
  if (!(error instanceof Error)) {
    return { errorName: 'unknown' };
  }
  const replyCode = readReplyCode(error);
  return { errorName: error.name, ...(replyCode === undefined ? {} : { replyCode }) };
}

/**
 * Publishes events to RabbitMQ for the outbox relay, on one connection and one confirm channel, to
 * the exchange of one producing domain (ADR-0005, ADR-0007). It is the only class that names
 * amqplib.
 *
 * - **Connecting is lazy.** Nothing opens until the relay calls `connect()`, which is idempotent,
 *   shares one attempt between concurrent calls, and reconnects after a loss.
 * - **It never reconnects by itself.** A lost connection or channel rejects the publishes in flight
 *   and drops the dead handles. The relay loop owns the backoff and calls `connect()` again.
 * - **Every publish settles on its own.** It resolves on its ack, rejects with
 *   `PublishNotConfirmedError` on a nack or when no confirm comes within
 *   `PUBLISH_CONFIRM_TIMEOUT_MS`, and with `BrokerUnavailableError` when the connection is lost or
 *   blocked. A timeout leaves the connection alone.
 * - **No backpressure handling.** amqplib queues a message even when its write buffer is full, and
 *   the relay's batch size (at most 500) bounds the memory in flight.
 */
export class AmqpEventPublisher implements EventPublisher {
  private readonly connectionUrl: string;
  private readonly exchangeName: string;
  private readonly openConnection: AmqpConnect;
  private session: Session | undefined;
  private connecting: Promise<void> | undefined;
  private isClosed = false;

  /**
   * @param dependencies - The broker URL, the domain, a logger and, in tests, a fake `connect`.
   * @throws InvalidEventDomainError when the domain is not lower-case letters and underscores.
   * @throws InvalidBrokerUrlError when the URL cannot be parsed. The error never carries the URL.
   */
  constructor(private readonly dependencies: AmqpEventPublisherDependencies) {
    this.exchangeName = buildEventExchangeName(dependencies.domain);
    this.openConnection = dependencies.connect ?? connectWithAmqplib;
    this.connectionUrl = this.buildConnectionUrl(dependencies.url);
  }

  /**
   * Makes sure the connection, the topology and the confirm channel are ready. Does nothing while
   * they are. Concurrent calls share one attempt.
   *
   * @throws BrokerUnavailableError when the broker cannot be reached, the connection is lost or
   * blocked (also when it was blocked while this call opened it), or the publisher is closed.
   * @throws TopologyDeclarationError when the broker refuses to declare the topology, which repeats
   * until a person fixes the topology or the permissions.
   */
  async connect(): Promise<void> {
    if (this.isClosed) {
      throw new BrokerUnavailableError(new Error(CLOSED_REASON));
    }
    if (this.session === undefined) {
      this.connecting ??= this.openSession().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
    if (this.session?.isBlocked === true) {
      throw new BrokerUnavailableError(new Error(BLOCKED_REASON));
    }
  }

  /**
   * Publishes the event to the domain's exchange with its type as routing key and waits for the
   * broker's confirm. Delivery is at-least-once, so the same event may be published twice.
   *
   * @param event - The event to send.
   * @throws PublishNotConfirmedError when the broker nacked it or did not confirm in time.
   * @throws BrokerUnavailableError when the publisher is not connected, the connection or channel
   * is lost, or the broker is blocking the connection.
   */
  async publish(event: EventEnvelope): Promise<void> {
    const { session, channel } = this.requireUsableSession();
    const content = Buffer.from(JSON.stringify(event));
    const pending = new PendingPublish(PUBLISH_CONFIRM_TIMEOUT_MS, (settled) => {
      session.pending.delete(settled);
    });
    session.pending.add(pending);
    try {
      channel.publish(
        this.exchangeName,
        event.type,
        content,
        buildPublishOptions(event),
        (error) => {
          this.settleConfirm(pending, error);
        },
      );
    } catch (error) {
      pending.fail(new BrokerUnavailableError(error));
    }
    await pending.promise;
  }

  /**
   * Closes the channel and then the connection and makes every later call fail. It rejects the
   * publishes in flight, cancels a `connect()` that is still opening (the connection it opens is
   * closed at once), never throws, and gives up on a close that does not finish within
   * `AMQP_CLOSE_TIMEOUT_MS`. Safe to call twice.
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const session = this.session;
    this.session = undefined;
    if (session === undefined) {
      return;
    }
    session.isLost = true;
    this.rejectPending(session, new BrokerUnavailableError(new Error(CLOSED_REASON)));
    const channel = session.channel;
    if (channel !== undefined) {
      await this.closeWithinTimeout(() => channel.close());
    }
    await this.closeWithinTimeout(() => session.connection.close());
  }

  /**
   * Opens a connection, declares the topology and opens the confirm channel. On any failure the
   * connection it opened is closed again.
   *
   * @throws BrokerUnavailableError or TopologyDeclarationError, as `connect()` documents.
   */
  private async openSession(): Promise<void> {
    const connection = await this.openBrokerConnection();
    const session = this.watchConnection(connection);
    try {
      this.assertNotClosed();
      await this.declareTopology(connection);
      session.channel = await this.openConfirmChannel(connection, session);
      this.assertNotClosed();
      this.assertNotLost(session);
    } catch (error) {
      session.isLost = true;
      await this.closeWithinTimeout(() => connection.close());
      throw this.toRelayError(error);
    }
    this.session = session;
  }

  /**
   * @returns A new connection to the broker.
   * @throws BrokerUnavailableError when it cannot be opened. The driver's message, which can carry
   * the URL, is kept only as the error's cause.
   */
  private async openBrokerConnection(): Promise<AmqpConnectionLike> {
    try {
      return await this.openConnection(this.connectionUrl, { timeout: AMQP_CONNECT_TIMEOUT_MS });
    } catch (error) {
      throw new BrokerUnavailableError(error);
    }
  }

  /**
   * Declares the topology on a channel of its own, because the broker closes a channel it refuses
   * and the channel that publishes must not be that one.
   *
   * @param connection - The open connection.
   */
  private async declareTopology(connection: AmqpConnectionLike): Promise<void> {
    const channel = await connection.createChannel();
    // A refusal reaches the caller through the rejected declaration. The broker also raises
    // `error` on the channel, and an event nobody listens to would be thrown.
    channel.on('error', () => undefined);
    try {
      await declareEventTopology(channel, this.dependencies.domain);
    } finally {
      await this.closeWithinTimeout(() => channel.close());
    }
  }

  /**
   * @param connection - The open connection.
   * @param session - The session that owns the connection.
   * @returns The confirm channel, whose loss ends the session.
   */
  private async openConfirmChannel(
    connection: AmqpConnectionLike,
    session: Session,
  ): Promise<AmqpChannelLike> {
    const channel = await connection.createConfirmChannel();
    channel.on('error', (error) => {
      this.loseSession(session, error);
    });
    channel.on('close', (error) => {
      this.loseSession(session, error);
    });
    return channel;
  }

  /**
   * Starts listening to a new connection. `error` always has a listener, so a driver error can
   * never become an uncaught exception.
   *
   * @param connection - The new connection.
   * @returns The session that tracks it.
   */
  private watchConnection(connection: AmqpConnectionLike): Session {
    const session: Session = {
      connection,
      channel: undefined,
      isBlocked: false,
      isLost: false,
      pending: new Set(),
    };
    connection.on('error', (error) => {
      this.loseSession(session, error);
    });
    connection.on('close', (error) => {
      this.loseSession(session, error);
    });
    connection.on('blocked', () => {
      this.blockSession(session);
    });
    connection.on('unblocked', () => {
      this.unblockSession(session);
    });
    return session;
  }

  /**
   * Ends a session whose connection or channel is gone: logs it once, forgets it, rejects the
   * publishes in flight and closes whatever is left of the connection. The next `connect()` opens
   * a new one.
   *
   * @param session - The session that was lost.
   * @param error - What the driver reported, logged by name and reply code only.
   */
  private loseSession(session: Session, error: unknown): void {
    if (session.isLost) {
      return;
    }
    session.isLost = true;
    if (this.session === session) {
      this.session = undefined;
    }
    this.dependencies.logger.warn(describeErrorForLog(error), 'broker connection closed');
    this.rejectPending(session, new BrokerUnavailableError(error));
    void this.closeWithinTimeout(() => session.connection.close());
  }

  /**
   * The broker blocks a connection under a memory or disk alarm. The publishes in flight are
   * rejected at once as unavailable, so no row is charged an attempt for an outage.
   *
   * @param session - The blocked session.
   */
  private blockSession(session: Session): void {
    if (session.isLost || session.isBlocked) {
      return;
    }
    session.isBlocked = true;
    this.dependencies.logger.warn('broker blocked the connection');
    this.rejectPending(session, new BrokerUnavailableError(new Error(BLOCKED_REASON)));
  }

  /**
   * @param session - The session the broker no longer blocks.
   */
  private unblockSession(session: Session): void {
    if (!session.isBlocked) {
      return;
    }
    session.isBlocked = false;
    this.dependencies.logger.info('broker unblocked the connection');
  }

  /**
   * @param session - The session whose publishes in flight fail.
   * @param error - What each of them rejects with.
   */
  private rejectPending(session: Session, error: Error): void {
    [...session.pending].forEach((pending) => {
      pending.fail(error);
    });
  }

  /**
   * Settles one publish from the argument of its confirm callback.
   *
   * @param pending - The publish.
   * @param error - What amqplib passed: nothing for an ack, `message nacked` for a nack, anything
   * else when the channel closed under the publish.
   */
  private settleConfirm(pending: PendingPublish, error: unknown): void {
    if (error === null || error === undefined) {
      pending.confirm();
    } else if (error instanceof Error && error.message === NACK_ERROR_MESSAGE) {
      pending.fail(new PublishNotConfirmedError('nack', error));
    } else {
      pending.fail(new BrokerUnavailableError(error));
    }
  }

  /**
   * @returns The session to publish on and its confirm channel.
   * @throws BrokerUnavailableError when closed, not connected or blocked.
   */
  private requireUsableSession(): { session: Session; channel: AmqpChannelLike } {
    if (this.isClosed) {
      throw new BrokerUnavailableError(new Error(CLOSED_REASON));
    }
    const session = this.session;
    const channel = session?.channel;
    if (session === undefined || channel === undefined) {
      throw new BrokerUnavailableError(new Error(NOT_CONNECTED_REASON));
    }
    if (session.isBlocked) {
      throw new BrokerUnavailableError(new Error(BLOCKED_REASON));
    }
    return { session, channel };
  }

  /**
   * @param session - The session that has just finished opening.
   * @throws BrokerUnavailableError when the connection or channel was lost while it was opening.
   * Installing such a session would leave a dead one that `connect()` never replaces.
   */
  private assertNotLost(session: Session): void {
    if (session.isLost) {
      throw new BrokerUnavailableError(new Error(LOST_WHILE_OPENING_REASON));
    }
  }

  /**
   * @param brokerUrl - The URL from the configuration.
   * @returns The URL to connect with. The heartbeat is code, not configuration, because it must
   * stay inside the confirm timeout, so it replaces any `heartbeat` the URL carries.
   * @throws InvalidBrokerUrlError when the URL cannot be parsed. The error that `new URL` throws
   * keeps the whole URL, password included, on an `input` property, so it is never rethrown.
   */
  private buildConnectionUrl(brokerUrl: string): string {
    let url: URL;
    try {
      url = new URL(brokerUrl);
    } catch {
      throw new InvalidBrokerUrlError();
    }
    url.searchParams.set('heartbeat', String(AMQP_HEARTBEAT_SECONDS));
    return url.toString();
  }

  /**
   * @throws BrokerUnavailableError when `close()` was called while the connection was opening.
   */
  private assertNotClosed(): void {
    if (this.isClosed) {
      throw new BrokerUnavailableError(new Error(CLOSED_REASON));
    }
  }

  /**
   * @param error - What failed while opening a session.
   * @returns The error to throw from `connect()`: a typed relay error as it is, anything else
   * as `BrokerUnavailableError`.
   */
  private toRelayError(error: unknown): Error {
    if (error instanceof BrokerUnavailableError || error instanceof TopologyDeclarationError) {
      return error;
    }
    return new BrokerUnavailableError(error);
  }

  /**
   * Runs a close and gives up waiting after `AMQP_CLOSE_TIMEOUT_MS`. It never throws: a close that
   * fails is logged by error name only.
   *
   * @param close - The close to run.
   */
  private async closeWithinTimeout(close: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = close().catch((error: unknown) => {
      this.dependencies.logger.warn(describeErrorForLog(error), 'closing the broker link failed');
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, AMQP_CLOSE_TIMEOUT_MS);
    });
    await Promise.race([closing, timeout]);
    clearTimeout(timer);
  }
}
