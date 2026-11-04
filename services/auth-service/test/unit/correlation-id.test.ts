import { runWithCorrelationId } from '@ticketnest/logger';
import { describe, expect, it } from 'vitest';

import { readOrCreateCorrelationId } from '@/correlation-id';

describe('readOrCreateCorrelationId', () => {
  it('returns the id of the current request', () => {
    const id = runWithCorrelationId('req-from-header', () => readOrCreateCorrelationId());

    expect(id).toBe('req-from-header');
  });

  it('creates a new id when there is no request context', () => {
    const first = readOrCreateCorrelationId();
    const second = readOrCreateCorrelationId();

    expect(first).not.toBe('');
    expect(first).not.toBe(second);
  });
});
