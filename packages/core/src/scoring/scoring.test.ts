import { describe, expect, it } from 'vitest';
import { midiToFrequencyHz } from '../note/note.js';
import {
  DEFAULT_IN_TUNE_CENTS_TOLERANCE,
  DEFAULT_MAX_FREQUENCY_HZ,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_DWELL_TIME_MS,
  DEFAULT_MIN_FREQUENCY_HZ,
  TargetNoteDwellTracker,
  centsOffTarget,
  gateReading,
  isWithinTolerance,
  type PitchReading,
} from './scoring.js';

const voiced = (frequencyHz: number, confidence = 0.9): PitchReading => ({
  voiced: true,
  frequencyHz,
  confidence,
});
const unvoiced: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

describe('defaults', () => {
  it('documents the chosen tunables', () => {
    expect(DEFAULT_IN_TUNE_CENTS_TOLERANCE).toBe(25);
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.5);
    expect(DEFAULT_MIN_FREQUENCY_HZ).toBe(150);
    expect(DEFAULT_MAX_FREQUENCY_HZ).toBe(1600);
    expect(DEFAULT_MIN_DWELL_TIME_MS).toBe(150);
  });
});

describe('gateReading', () => {
  it('rejects an unvoiced reading', () => {
    expect(gateReading(unvoiced)).toEqual({ ok: false });
  });

  it('accepts a voiced, confident, in-range reading', () => {
    expect(gateReading(voiced(440, 0.9))).toEqual({ ok: true, frequencyHz: 440 });
  });

  it('rejects a voiced reading below the confidence threshold', () => {
    expect(gateReading(voiced(440, 0.49))).toEqual({ ok: false });
  });

  it('accepts exactly at the confidence threshold (boundary is inclusive)', () => {
    expect(gateReading(voiced(440, 0.5))).toEqual({ ok: true, frequencyHz: 440 });
  });

  it('rejects frequencies outside the plausible violin range on either side', () => {
    expect(gateReading(voiced(149.9))).toEqual({ ok: false });
    expect(gateReading(voiced(1600.1))).toEqual({ ok: false });
  });

  it('accepts exactly at the plausible-range boundaries (inclusive)', () => {
    expect(gateReading(voiced(150))).toEqual({ ok: true, frequencyHz: 150 });
    expect(gateReading(voiced(1600))).toEqual({ ok: true, frequencyHz: 1600 });
  });

  it('respects overridden config', () => {
    expect(gateReading(voiced(100, 0.9), { minFrequencyHz: 50 })).toEqual({
      ok: true,
      frequencyHz: 100,
    });
    expect(gateReading(voiced(440, 0.6), { minConfidence: 0.7 })).toEqual({ ok: false });
  });
});

describe('centsOffTarget', () => {
  it('is 0 exactly on target', () => {
    expect(centsOffTarget(440, 440)).toBeCloseTo(0, 9);
  });

  it('is positive when sharp of target, negative when flat', () => {
    expect(centsOffTarget(445, 440)).toBeGreaterThan(0);
    expect(centsOffTarget(435, 440)).toBeLessThan(0);
  });
});

describe('isWithinTolerance: boundary cases', () => {
  it('is true at exactly the default tolerance boundary (25c), inclusive', () => {
    expect(isWithinTolerance(25)).toBe(true);
    expect(isWithinTolerance(-25)).toBe(true);
  });

  it('is false just past the default tolerance boundary', () => {
    expect(isWithinTolerance(25.01)).toBe(false);
    expect(isWithinTolerance(-25.01)).toBe(false);
  });

  it('is true at 0 and comfortably inside the band', () => {
    expect(isWithinTolerance(0)).toBe(true);
    expect(isWithinTolerance(10)).toBe(true);
    expect(isWithinTolerance(-10)).toBe(true);
  });

  it('respects a custom tolerance override', () => {
    expect(isWithinTolerance(10, { inTuneCentsTolerance: 5 })).toBe(false);
    expect(isWithinTolerance(5, { inTuneCentsTolerance: 5 })).toBe(true);
  });
});

describe('TargetNoteDwellTracker', () => {
  const target = 440;

  it('does not satisfy on a single in-tune reading shorter than the dwell time', () => {
    const tracker = new TargetNoteDwellTracker(target);
    expect(tracker.update(voiced(440), 0)).toBe(false);
    expect(tracker.isSatisfied).toBe(false);
  });

  it('satisfies exactly once the cumulative in-tune hold reaches minDwellTimeMs (boundary inclusive)', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 150 });
    expect(tracker.update(voiced(440), 0)).toBe(false);
    expect(tracker.update(voiced(440), 100)).toBe(false);
    expect(tracker.update(voiced(440), 149)).toBe(false); // 149ms held: just short
    expect(tracker.update(voiced(440), 150)).toBe(true); // 150ms held: boundary, satisfied
    expect(tracker.isSatisfied).toBe(true);
  });

  it('returns false on every call after the triggering one, even though isSatisfied stays true', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toBe(true);
    expect(tracker.update(voiced(440), 150)).toBe(false);
    expect(tracker.isSatisfied).toBe(true);
  });

  it('is sticky: dropping out after success does not un-succeed it (bow release at the end of a held note)', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440), 100);
    expect(tracker.isSatisfied).toBe(true);
    tracker.update(unvoiced, 150);
    expect(tracker.isSatisfied).toBe(true);
  });

  it('resets the held-duration clock on a single out-of-tolerance reading (strict continuity, no cumulative gaps)', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 150 });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440), 100); // 100ms held
    tracker.update(voiced(500), 120); // wildly off-target: resets
    expect(tracker.currentHeldMs).toBe(0);
    expect(tracker.update(voiced(440), 140)).toBe(false); // held again from t=140, only 0ms so far
    expect(tracker.update(voiced(440), 290)).toBe(true); // 150ms held from the restarted clock
  });

  it('resets the held-duration clock on an unvoiced (no-signal) reading', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 150 });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440), 100);
    tracker.update(unvoiced, 110);
    expect(tracker.currentHeldMs).toBe(0);
    expect(tracker.isSatisfied).toBe(false);
  });

  it('resets the held-duration clock on a low-confidence reading (gated to "unclear")', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 150 });
    tracker.update(voiced(440, 0.9), 0);
    tracker.update(voiced(440, 0.9), 100);
    tracker.update(voiced(440, 0.1), 110); // in-tune frequency, but confidence too low
    expect(tracker.currentHeldMs).toBe(0);
  });

  it('does not satisfy on a note that is confidently detected but out of tune the whole time', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 150 });
    // A whole semitone flat (100c off), continuously, for well beyond the dwell window.
    const flat = midiToFrequencyHz(69 - 1);
    for (let t = 0; t <= 500; t += 50) {
      expect(tracker.update(voiced(flat), t)).toBe(false);
    }
    expect(tracker.isSatisfied).toBe(false);
  });

  it('honors a custom inTuneCentsTolerance', () => {
    const tightTracker = new TargetNoteDwellTracker(target, {
      minDwellTimeMs: 100,
      inTuneCentsTolerance: 5,
    });
    // ~19.6 cents sharp -- within the default 25c tolerance but outside a tightened 5c one.
    tightTracker.update(voiced(445), 0);
    expect(tightTracker.update(voiced(445), 100)).toBe(false);

    const looseTracker = new TargetNoteDwellTracker(target, {
      minDwellTimeMs: 100,
      inTuneCentsTolerance: 30,
    });
    looseTracker.update(voiced(445), 0);
    expect(looseTracker.update(voiced(445), 100)).toBe(true);
  });

  it('reset() clears state so the instance can be reused for a new attempt', () => {
    const tracker = new TargetNoteDwellTracker(target, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toBe(true);
    tracker.reset();
    expect(tracker.isSatisfied).toBe(false);
    expect(tracker.currentHeldMs).toBe(0);
    expect(tracker.update(voiced(440), 1000)).toBe(false);
    expect(tracker.update(voiced(440), 1100)).toBe(true);
  });

  it('throws on construction with a non-positive target frequency', () => {
    expect(() => new TargetNoteDwellTracker(0)).toThrow(RangeError);
    expect(() => new TargetNoteDwellTracker(-1)).toThrow(RangeError);
  });

  it('throws if fed a decreasing timestamp', () => {
    const tracker = new TargetNoteDwellTracker(target);
    tracker.update(voiced(440), 100);
    expect(() => tracker.update(voiced(440), 50)).toThrow(RangeError);
  });
});
