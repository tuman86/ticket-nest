import { InternalServerError } from '@ticketnest/errors';

const TOPOLOGY_DECLARATION_FAILED_CODE = 'TOPOLOGY_DECLARATION_FAILED';

/** What `TopologyDeclarationError` needs to say which declaration the broker refused and why. */
export interface TopologyDeclarationErrorDetails {
  /** The exchange or queue whose declaration was refused. */
  readonly objectName: string;
  /** The AMQP reply code of the refusal, for example 406 (PRECONDITION_FAILED). */
  readonly replyCode: number;
  /** The broker's own explanation of the refusal. */
  readonly brokerReply: string;
  /** The driver error behind it. */
  readonly cause?: unknown;
}

/**
 * 500: the broker refused to declare an exchange or queue of the topology (ADR-0005), for example
 * because it already exists with other arguments (406) or the user may not configure it (403).
 *
 * Unlike `BrokerUnavailableError` this does not go away by itself: the declarations are repeated
 * on every connect and fail the same way until a person migrates the topology or fixes the
 * permissions. The relay logs it at error level on every tick, publishes nothing and charges no
 * row an attempt, while the API keeps accepting writes into the outbox.
 *
 * The detail is fixed text with the object name and the reply code. The broker's own text sits in
 * `brokerReply` so the log shows what to fix. It comes from the broker's reply to a channel-level
 * refusal and never carries the connection URL, which is why it may be logged, unlike the message
 * of a connection error.
 */
export class TopologyDeclarationError extends InternalServerError {
  readonly objectName: string;
  readonly replyCode: number;
  readonly brokerReply: string;

  /**
   * @param details - Which declaration was refused, with which code, and the broker's explanation.
   */
  constructor(details: TopologyDeclarationErrorDetails) {
    super({
      code: TOPOLOGY_DECLARATION_FAILED_CODE,
      detail: `The broker refused to declare ${details.objectName} (reply code ${String(details.replyCode)}).`,
      cause: details.cause,
    });
    this.objectName = details.objectName;
    this.replyCode = details.replyCode;
    this.brokerReply = details.brokerReply;
  }
}
