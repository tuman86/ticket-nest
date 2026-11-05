import { describe, expect, it } from 'vitest';

import { InvalidBrokerUrlError } from '@/relay/invalid-broker-url.error';

describe('InvalidBrokerUrlError', () => {
  it('is a 500 with its own machine code', () => {
    const error = new InvalidBrokerUrlError();

    expect(error.status).toBe(500);
    expect(error.code).toBe('INVALID_BROKER_URL');
  });

  it('carries no cause and no extra property, because the URL it rejects holds a password', () => {
    const error = new InvalidBrokerUrlError();

    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).not.toContain('input');
    expect(error.detail).toBe('The broker URL is not a valid URL.');
  });
});
