import { describe, expect, it } from 'vitest';

import { parseStoredEvent } from '@/relay/parse-stored-event';

import { buildStoredEvent, EVENT_ID } from '../support/build-event';

describe('parseStoredEvent', () => {
  it('returns the parsed envelope for a valid payload', () => {
    const result = parseStoredEvent(buildStoredEvent());

    expect(result).toMatchObject({
      isValid: true,
      event: { id: EVENT_ID, type: 'user.registered' },
    });
  });

  it.each([{ nested: { deep: true } }, 'text', 42, null, []])(
    'accepts %j as the data of an event',
    (data) => {
      expect(parseStoredEvent(buildStoredEvent({ data })).isValid).toBe(true);
    },
  );

  it('fails for a missing field and names only that field', () => {
    const withoutCorrelationId = Object.fromEntries(
      Object.entries(buildStoredEvent()).filter(([field]) => field !== 'correlationId'),
    );

    const result = parseStoredEvent(withoutCorrelationId);

    expect(result).toEqual({ isValid: false, failedFields: ['correlationId'] });
  });

  it.each([null, 'text', 42, []])('fails for %j, which is not an event object', (payload) => {
    expect(parseStoredEvent(payload)).toEqual({ isValid: false, failedFields: ['(event)'] });
  });

  it('never puts a value of the payload into the failure', () => {
    const result = parseStoredEvent(buildStoredEvent({ id: 'secret-value-123' }));

    expect(result.isValid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-value-123');
  });
});
