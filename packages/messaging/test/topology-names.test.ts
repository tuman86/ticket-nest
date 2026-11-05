import { describe, expect, it } from 'vitest';

import { InvalidEventDomainError } from '@/invalid-event-domain.error';
import {
  buildEventExchangeName,
  buildUnroutedExchangeName,
  buildUnroutedQueueName,
} from '@/topology-names';

const INVALID_DOMAINS = ['', 'Auth', 'auth.events', 'auth service'];

describe('buildEventExchangeName', () => {
  it('names the topic exchange of a producing domain', () => {
    expect(buildEventExchangeName('auth')).toBe('auth.events');
  });

  it.each(INVALID_DOMAINS)('rejects the domain %j', (domain) => {
    expect(() => buildEventExchangeName(domain)).toThrow(InvalidEventDomainError);
  });
});

describe('buildUnroutedExchangeName', () => {
  it('names the alternate exchange of a producing domain', () => {
    expect(buildUnroutedExchangeName('auth')).toBe('auth.events.unrouted');
  });

  it.each(INVALID_DOMAINS)('rejects the domain %j', (domain) => {
    expect(() => buildUnroutedExchangeName(domain)).toThrow(InvalidEventDomainError);
  });
});

describe('buildUnroutedQueueName', () => {
  it('names the catch-all queue of a producing domain', () => {
    expect(buildUnroutedQueueName('auth')).toBe('auth.unrouted');
  });

  it.each(INVALID_DOMAINS)('rejects the domain %j', (domain) => {
    expect(() => buildUnroutedQueueName(domain)).toThrow(InvalidEventDomainError);
  });
});
