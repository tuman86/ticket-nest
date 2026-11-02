import { describe, expect, it } from 'vitest';

import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('lower-cases the address', () => {
    expect(normalizeEmail('Asha.Rao@Example.COM')).toBe('asha.rao@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  asha@example.com \n')).toBe('asha@example.com');
  });

  it('keeps dots and plus tags, so they stay separate accounts', () => {
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
  });
});
