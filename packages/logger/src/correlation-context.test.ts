import { describe, expect, it } from 'vitest';

import {
  generateCorrelationId,
  getCorrelationId,
  REQUEST_ID_HEADER,
  runWithCorrelationId,
} from './correlation-context';

describe('correlation context', () => {
  it('is undefined outside a context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the id inside the context and the work result', () => {
    const result = runWithCorrelationId('corr-1', () => getCorrelationId());

    expect(result).toBe('corr-1');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('lets an inner context override and then restore the outer one', () => {
    runWithCorrelationId('outer', () => {
      runWithCorrelationId('inner', () => {
        expect(getCorrelationId()).toBe('inner');
      });
      expect(getCorrelationId()).toBe('outer');
    });
  });

  it('generates distinct UUIDs', () => {
    const first = generateCorrelationId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(generateCorrelationId()).not.toBe(first);
  });

  it('exposes the documented header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
