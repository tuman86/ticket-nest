import { EventEnvelope } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { OutboxWriter } from '@/outbox-writer';

import { InMemoryOutboxStore } from './support/in-memory-outbox-store';

describe('OutboxWriter schema guard', () => {
  it('refuses the base envelope schema at compile time, because its data is not declared', () => {
    const event = {
      id: '5d0f8f55-3d1c-4b0a-8a53-2f7b9c1e4a11',
      type: 'user.registered',
      version: 1,
      occurredAt: '2026-11-04T10:00:00Z',
      aggregateId: 'aggregate-1',
      aggregateVersion: 1,
      correlationId: 'req-123',
      causationId: null,
      tenantId: null,
      data: {},
    };
    const writer = new OutboxWriter<object>(new InMemoryOutboxStore<object>());

    // @ts-expect-error The base envelope keeps any `data` unchanged, so it is not a valid event schema.
    const attempt = writer.add({}, EventEnvelope, event);

    expect(attempt).toBeInstanceOf(Promise);
    return attempt.catch(() => undefined);
  });
});
