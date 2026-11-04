import { describe, expect, it } from 'vitest';

import { httpOriginSchema, originListSchema } from '@/origin';

describe('originListSchema', () => {
  it('defaults to no origin, which denies every browser origin', () => {
    expect(originListSchema.parse(undefined)).toEqual([]);
    expect(originListSchema.parse('')).toEqual([]);
  });

  it('splits on commas and trims each origin', () => {
    expect(originListSchema.parse('https://a.example, https://b.example:8443')).toEqual([
      'https://a.example',
      'https://b.example:8443',
    ]);
  });

  it.each(['https://a.example/', 'a.example', 'https://a.example/path'])(
    'rejects %j, which is not a bare origin',
    (value) => {
      expect(originListSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('httpOriginSchema', () => {
  it.each(['http://localhost:4001', 'https://auth.internal.example'])('accepts %s', (value) => {
    expect(httpOriginSchema.parse(value)).toBe(value);
  });

  it.each([
    'http://localhost:4001/',
    'http://localhost:4001/v1',
    'ftp://files.example',
    'localhost:4001',
    '',
  ])('rejects %j', (value) => {
    expect(httpOriginSchema.safeParse(value).success).toBe(false);
  });
});
