import { describe, expect, it } from 'vitest';

import { BrokerUnavailableError } from '@/broker-unavailable.error';

describe('BrokerUnavailableError', () => {
  it('is a 500 with its own machine code', () => {
    const error = new BrokerUnavailableError(new Error('connection refused'));

    expect(error.status).toBe(500);
    expect(error.code).toBe('BROKER_UNAVAILABLE');
  });

  it('keeps the cause but never copies it into the detail, because it can hold a broker URL with a password', () => {
    const cause = new Error('connect failed for amqp://user:secret@broker:5672');

    const error = new BrokerUnavailableError(cause);

    expect(error.cause).toBe(cause);
    expect(error.detail).not.toContain('secret');
  });
});
