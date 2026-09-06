import { describe, expect, it } from 'vitest';
import { RollingStats } from './rolling-stats';

describe('RollingStats', () => {
  it('reports undefined last/mean before anything is pushed', () => {
    const stats = new RollingStats();
    expect(stats.last).toBeUndefined();
    expect(stats.mean).toBeUndefined();
    expect(stats.count).toBe(0);
  });

  it('tracks last and mean across pushes', () => {
    const stats = new RollingStats();
    stats.push(1);
    stats.push(2);
    stats.push(3);
    expect(stats.last).toBe(3);
    expect(stats.mean).toBe(2);
    expect(stats.count).toBe(3);
  });

  it('evicts the oldest value once the window is exceeded', () => {
    const stats = new RollingStats(3);
    stats.push(1);
    stats.push(2);
    stats.push(3);
    stats.push(4); // evicts the 1
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(3); // (2+3+4)/3
    expect(stats.last).toBe(4);
  });

  it('ignores non-finite values instead of poisoning the mean', () => {
    const stats = new RollingStats();
    stats.push(10);
    stats.push(Number.NaN);
    stats.push(Number.POSITIVE_INFINITY);
    stats.push(Number.NEGATIVE_INFINITY);
    stats.push(20);
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(15);
    expect(stats.last).toBe(20);
  });

  it('reset() clears all history', () => {
    const stats = new RollingStats();
    stats.push(5);
    stats.push(7);
    stats.reset();
    expect(stats.count).toBe(0);
    expect(stats.last).toBeUndefined();
    expect(stats.mean).toBeUndefined();
  });

  it('throws on a non-positive or non-integer window size', () => {
    expect(() => new RollingStats(0)).toThrow(RangeError);
    expect(() => new RollingStats(-1)).toThrow(RangeError);
    expect(() => new RollingStats(1.5)).toThrow(RangeError);
  });

  it('supports a window size of 1 (only the latest value survives)', () => {
    const stats = new RollingStats(1);
    stats.push(1);
    stats.push(2);
    expect(stats.count).toBe(1);
    expect(stats.last).toBe(2);
    expect(stats.mean).toBe(2);
  });
});
