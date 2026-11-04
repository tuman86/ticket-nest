import { describe, expect, it } from 'vitest';

import { EventEnvelopeBuilder } from '@/event-envelope-builder';

import { FixedClock } from './support/fixed-clock';
import { SequentialIdGenerator } from './support/sequential-id-generator';

const USER_ID = '0b9c5b0e-6a0d-4c2b-9d5e-3f1d6a7c8e90';
const TENANT_ID = '7c1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f';

/**
 * @returns A builder with sequential ids and a clock fixed at 2026-11-04T10:00:00Z.
 */
function buildEnvelopeBuilder(): EventEnvelopeBuilder {
  return new EventEnvelopeBuilder({
    idGenerator: new SequentialIdGenerator(),
    clock: new FixedClock(new Date('2026-11-04T10:00:00.000Z')),
  });
}

describe('EventEnvelopeBuilder', () => {
  it('fills the id and the time from its generator and clock', () => {
    const envelope = buildEnvelopeBuilder().build({
      type: 'user.registered',
      version: 1,
      aggregateId: USER_ID,
      aggregateVersion: 1,
      correlationId: 'req-123',
      data: { userId: USER_ID },
    });

    expect(envelope.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(envelope.occurredAt).toBe('2026-11-04T10:00:00.000Z');
  });

  it('copies the fields the caller gives it', () => {
    const envelope = buildEnvelopeBuilder().build({
      type: 'user.registered',
      version: 1,
      aggregateId: USER_ID,
      aggregateVersion: 3,
      correlationId: 'req-123',
      causationId: 'cause-9',
      tenantId: TENANT_ID,
      data: { userId: USER_ID },
    });

    expect(envelope).toMatchObject({
      type: 'user.registered',
      version: 1,
      aggregateId: USER_ID,
      aggregateVersion: 3,
      correlationId: 'req-123',
      causationId: 'cause-9',
      tenantId: TENANT_ID,
      data: { userId: USER_ID },
    });
  });

  it('defaults the causation and the tenant to null', () => {
    const envelope = buildEnvelopeBuilder().build({
      type: 'user.registered',
      version: 1,
      aggregateId: USER_ID,
      aggregateVersion: 1,
      correlationId: 'req-123',
      data: {},
    });

    expect(envelope.causationId).toBeNull();
    expect(envelope.tenantId).toBeNull();
  });

  it('gives every event its own id', () => {
    const builder = buildEnvelopeBuilder();
    const input = {
      type: 'user.registered',
      version: 1,
      aggregateId: USER_ID,
      aggregateVersion: 1,
      correlationId: 'req-123',
      data: {},
    };

    expect(builder.build(input).id).not.toBe(builder.build(input).id);
  });
});
