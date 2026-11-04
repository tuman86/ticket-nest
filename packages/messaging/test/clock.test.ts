import { describe, expect, it } from 'vitest';

import { SystemClock } from '@/clock';

describe('SystemClock', () => {
  it('reads the current time', () => {
    const before = Date.now();

    const reading = new SystemClock().now().getTime();

    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(Date.now());
  });
});
