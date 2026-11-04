import { describe, expect, it } from 'vitest';

import { buildPathAndQuery } from '@/proxy/build-path-and-query';

describe('buildPathAndQuery', () => {
  it('returns the path alone when the URL has no query', () => {
    expect(buildPathAndQuery({ path: '/v1/movies', originalUrl: '/v1/movies' })).toBe('/v1/movies');
  });

  it('appends the raw query string, including its question mark', () => {
    expect(
      buildPathAndQuery({ path: '/v1/movies', originalUrl: '/v1/movies?genre=drama&limit=5' }),
    ).toBe('/v1/movies?genre=drama&limit=5');
  });

  it('keeps an empty query as sent', () => {
    expect(buildPathAndQuery({ path: '/v1/movies', originalUrl: '/v1/movies?' })).toBe(
      '/v1/movies?',
    );
  });
});
