import { describe, expect, it } from 'vitest';

import { PublishNotConfirmedError } from '@/publish-not-confirmed.error';

describe('PublishNotConfirmedError', () => {
  it('is a 500 with its own machine code', () => {
    const error = new PublishNotConfirmedError('nack');

    expect(error.status).toBe(500);
    expect(error.code).toBe('PUBLISH_NOT_CONFIRMED');
  });

  it.each(['nack', 'confirm_timeout'] as const)(
    'exposes the reason %s and puts it in the detail',
    (reason) => {
      const error = new PublishNotConfirmedError(reason);

      expect(error.reason).toBe(reason);
      expect(error.detail).toContain(reason);
    },
  );

  it('keeps the cause when there is one', () => {
    const cause = new Error('cause');

    expect(new PublishNotConfirmedError('nack', cause).cause).toBe(cause);
  });
});
