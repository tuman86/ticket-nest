import { describe, expect, it } from 'vitest';

import { jsonBodyLimitSchema } from '@/json-body-limit';

describe('jsonBodyLimitSchema', () => {
  it('defaults to 100kb', () => {
    expect(jsonBodyLimitSchema.parse(undefined)).toBe('100kb');
  });

  it.each(['512b', '100kb', '1mb', '2MB', '10Kb', '0b'])(
    'accepts %s and returns it unchanged',
    (value) => {
      expect(jsonBodyLimitSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    ['an empty string', ''],
    ['a number without a unit', '100'],
    ['a fraction', '1.5mb'],
    ['an unsupported unit', '1gb'],
    ['a unit alone', 'kb'],
    ['a negative size', '-1kb'],
    ['a space before the unit', '1 kb'],
    ['surrounding whitespace', ' 1kb '],
  ])('rejects %s', (_label, value) => {
    expect(jsonBodyLimitSchema.safeParse(value).success).toBe(false);
  });
});
