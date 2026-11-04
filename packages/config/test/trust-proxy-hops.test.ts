import { describe, expect, it } from 'vitest';

import { trustProxyHopsSchema } from '@/trust-proxy-hops';

describe('trustProxyHopsSchema', () => {
  it('defaults to 0, so the socket address is used and a client cannot choose its IP', () => {
    expect(trustProxyHopsSchema.parse(undefined)).toBe(0);
  });

  it('reads a whole number from 0 to 10', () => {
    expect(trustProxyHopsSchema.parse('1')).toBe(1);
    expect(trustProxyHopsSchema.parse('10')).toBe(10);
  });

  it.each(['-1', '1.5', 'many', '11'])('rejects %j', (value) => {
    expect(trustProxyHopsSchema.safeParse(value).success).toBe(false);
  });
});
