import { EventEnvelope } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { buildPublishOptions } from '@/relay/build-publish-options';

import { buildStoredEvent, EVENT_CORRELATION_ID, EVENT_ID } from '../support/build-event';

const event = EventEnvelope.parse(buildStoredEvent());

describe('buildPublishOptions', () => {
  it('marks the message persistent', () => {
    expect(buildPublishOptions(event).persistent).toBe(true);
  });

  it('sets the content type to application/json', () => {
    expect(buildPublishOptions(event).contentType).toBe('application/json');
  });

  it('sets messageId to the event id', () => {
    expect(buildPublishOptions(event).messageId).toBe(EVENT_ID);
  });

  it('sets type to the event type', () => {
    expect(buildPublishOptions(event).type).toBe('user.registered');
  });

  it("sets correlationId to the envelope's correlation id", () => {
    expect(buildPublishOptions(event).correlationId).toBe(EVENT_CORRELATION_ID);
  });

  it('does not set mandatory, because the alternate exchange makes every event routable', () => {
    expect(buildPublishOptions(event)).not.toHaveProperty('mandatory');
  });

  it('sets no property beyond those ADR-0005 lists', () => {
    expect(Object.keys(buildPublishOptions(event)).sort()).toEqual([
      'contentType',
      'correlationId',
      'messageId',
      'persistent',
      'type',
    ]);
  });
});
