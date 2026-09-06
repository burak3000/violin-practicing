import { describe, expect, it } from 'vitest';
import { clamp } from './clamp.js';

describe('clamp', () => {
  it('returns the value unchanged when already inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps values below the minimum up to the minimum', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it('clamps values above the maximum down to the maximum', () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it('returns boundary values unchanged', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('throws a RangeError when min is greater than max', () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
