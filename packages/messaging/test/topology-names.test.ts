import { describe, expect, it } from 'vitest';

import { InvalidEventDomainError } from '@/invalid-event-domain.error';
import { buildEventExchangeName } from '@/topology-names';

describe('buildEventExchangeName', () => {
  it('names the topic exchange of a producing domain', () => {
    expect(buildEventExchangeName('auth')).toBe('auth.events');
  });

  it.each(['', 'Auth', 'auth.events', 'auth service'])('rejects the domain %j', (domain) => {
    expect(() => buildEventExchangeName(domain)).toThrow(InvalidEventDomainError);
  });
});
