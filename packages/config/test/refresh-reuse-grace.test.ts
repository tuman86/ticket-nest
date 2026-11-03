import { describe, expect, it } from 'vitest';

import {
  REFRESH_REUSE_GRACE_DEFAULT_MS,
  REFRESH_REUSE_GRACE_MAX_MS,
  refreshReuseGraceMsSchema,
} from '@/refresh-reuse-grace';

describe('refreshReuseGraceMsSchema', () => {
  it('defaults to 10 seconds when the variable is not set', () => {
    expect(refreshReuseGraceMsSchema.parse(undefined)).toBe(10_000);
    expect(REFRESH_REUSE_GRACE_DEFAULT_MS).toBe(10_000);
  });

  it('coerces a numeric string', () => {
    expect(refreshReuseGraceMsSchema.parse('5000')).toBe(5000);
  });

  it('allows 0, which turns the grace window off (strict reuse detection)', () => {
    expect(refreshReuseGraceMsSchema.parse('0')).toBe(0);
  });

  it('allows exactly the maximum of 30 seconds and rejects anything above it', () => {
    expect(REFRESH_REUSE_GRACE_MAX_MS).toBe(30_000);
    expect(refreshReuseGraceMsSchema.safeParse('30000').success).toBe(true);
    expect(refreshReuseGraceMsSchema.safeParse('30001').success).toBe(false);
  });

  it.each(['-1', '1.5', 'abc', 'Infinity', '1e9'])('rejects %j', (value) => {
    expect(refreshReuseGraceMsSchema.safeParse(value).success).toBe(false);
  });
});
