import { describe, expect, it } from 'vitest';

import { baseConfigSchema } from '@/base-config-schema';

describe('baseConfigSchema', () => {
  it('applies defaults for NODE_ENV and LOG_LEVEL', () => {
    const config = baseConfigSchema.parse({ PORT: '3000' });
    expect(config).toEqual({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('coerces PORT from a string to a number', () => {
    expect(baseConfigSchema.parse({ PORT: '8080' }).PORT).toBe(8080);
  });

  it.each(['0', '65536', '3.5', 'abc', '-1'])('rejects PORT %s', (port) => {
    expect(baseConfigSchema.safeParse({ PORT: port }).success).toBe(false);
  });

  it('requires PORT', () => {
    expect(baseConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown NODE_ENV and LOG_LEVEL values', () => {
    expect(baseConfigSchema.safeParse({ PORT: '3000', NODE_ENV: 'staging' }).success).toBe(false);
    expect(baseConfigSchema.safeParse({ PORT: '3000', LOG_LEVEL: 'verbose' }).success).toBe(false);
  });
});
