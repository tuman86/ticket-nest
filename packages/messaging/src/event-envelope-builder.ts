import { type EventEnvelope } from '@ticketnest/contracts';

import { type Clock } from './clock';
import { type IdGenerator } from './id-generator';

export interface EventEnvelopeBuilderDependencies {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
}

/** What the caller decides about an event. The builder adds the id and the time. */
export interface EventEnvelopeInput {
  /** Catalogue name, for example `user.registered`. */
  readonly type: string;
  readonly version: number;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  /** The request id or the correlation id of the event that led here. */
  readonly correlationId: string;
  /** Id of the message that caused this event. Null (the default) when nothing did. */
  readonly causationId?: string | null;
  /** The operator the event belongs to. Null (the default) when it belongs to none. */
  readonly tenantId?: string | null;
  readonly data: unknown;
}

/** Builds the envelope of docs/architecture.md section 6.2 around an event's data. */
export class EventEnvelopeBuilder {
  /**
   * @param dependencies - Where ids and times come from.
   */
  constructor(private readonly dependencies: EventEnvelopeBuilderDependencies) {}

  /**
   * Builds an envelope with a fresh id and the current time. It does not validate: the outbox
   * writer parses the result with the event's own schema.
   *
   * @param input - The fields the caller owns.
   * @returns The envelope, ready for `OutboxWriter.add`.
   */
  build(input: EventEnvelopeInput): EventEnvelope {
    const { idGenerator, clock } = this.dependencies;
    return {
      id: idGenerator.generate(),
      type: input.type,
      version: input.version,
      occurredAt: clock.now().toISOString(),
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      tenantId: input.tenantId ?? null,
      data: input.data,
    };
  }
}
