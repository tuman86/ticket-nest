import { describe, expect, it } from 'vitest';

import { shutdownTimeoutMsSchema } from '@/shutdown-timeout';

describe('shutdownTimeoutMsSchema', () => {
  it('defaults to 10 seconds', () => {
    expect(shutdownTimeoutMsSchema.parse(undefined)).toBe(10_000);
  });

  it('accepts 1 second to 2 minutes and rejects anything outside', () => {
    expect(shutdownTimeoutMsSchema.parse('1000')).toBe(1_000);
    expect(shutdownTimeoutMsSchema.parse('120000')).toBe(120_000);
    expect(shutdownTimeoutMsSchema.safeParse('999').success).toBe(false);
    expect(shutdownTimeoutMsSchema.safeParse('120001').success).toBe(false);
  });
});
