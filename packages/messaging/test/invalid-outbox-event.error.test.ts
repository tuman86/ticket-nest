import { describe, expect, it } from 'vitest';

import { InvalidOutboxEventError } from '@/invalid-outbox-event.error';

describe('InvalidOutboxEventError', () => {
  it('is a 500 with its own machine code', () => {
    const error = new InvalidOutboxEventError(['aggregateId'], new Error('cause'));

    expect(error.status).toBe(500);
    expect(error.code).toBe('INVALID_OUTBOX_EVENT');
  });

  it('lists the failed fields in the detail and keeps the cause', () => {
    const cause = new Error('cause');

    const error = new InvalidOutboxEventError(['aggregateId', 'data.userId'], cause);

    expect(error.detail).toContain('aggregateId, data.userId');
    expect(error.cause).toBe(cause);
  });
});
