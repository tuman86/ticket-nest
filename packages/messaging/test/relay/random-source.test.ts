import { afterEach, describe, expect, it, vi } from 'vitest';

import { MathRandomSource } from '@/relay/random-source';

const DRAW_COUNT = 200;

describe('MathRandomSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns what Math.random returns', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);

    expect(new MathRandomSource().next()).toBe(0.25);
  });

  it('returns numbers from 0 up to, but not including, 1', () => {
    const source = new MathRandomSource();

    const draws = Array.from({ length: DRAW_COUNT }, () => source.next());

    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
  });
});
