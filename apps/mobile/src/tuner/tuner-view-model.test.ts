import { describe, expect, it } from 'vitest';
import { analyzeTunerReading, TunerDisplaySmoother, type SmoothedTunerReading } from '@violin/core';
import {
  CLOSE_OUT_BOUNDARY_CENTS,
  formatCents,
  formatForDebug,
  formatFrequencyHz,
  inTuneZoneBounds,
  needlePercent,
  toneFor,
} from './tuner-view-model';

const NO_SIGNAL: SmoothedTunerReading = { status: 'no-signal' };
const UNCLEAR: SmoothedTunerReading = { status: 'unclear' };

/**
 * Builds a realistic 'reading'-status SmoothedTunerReading via the real
 * `analyzeTunerReading` + a fresh `TunerDisplaySmoother`, rather than
 * hand-rolling one -- keeps these tests honest about the actual contract
 * this view-model consumes (same pattern packages/core's own
 * tuner-display-smoother.test.ts uses). A fresh smoother per call and a
 * fixed timestamp mean each call is independent -- with only one sample
 * ever fed in, the smoother's boxcar average degenerates to exactly that
 * sample, so these fixtures are deterministic.
 */
function readingAt(frequencyHz: number, confidence = 0.9): SmoothedTunerReading {
  const smoother = new TunerDisplaySmoother();
  return smoother.update(analyzeTunerReading({ voiced: true, frequencyHz, confidence }), 0);
}

function expectReading(
  reading: SmoothedTunerReading,
): asserts reading is Extract<SmoothedTunerReading, { status: 'reading' }> {
  expect(reading.status).toBe('reading');
}

describe('toneFor', () => {
  it('maps no-signal/unclear straight through', () => {
    expect(toneFor(NO_SIGNAL)).toBe('no-signal');
    expect(toneFor(UNCLEAR)).toBe('unclear');
  });

  it('maps an exactly-in-tune reading to in-tune', () => {
    expect(toneFor(readingAt(440))).toBe('in-tune');
  });

  it('CLOSE_OUT_BOUNDARY_CENTS sits exactly halfway between the default tolerance and 50c', () => {
    expect(CLOSE_OUT_BOUNDARY_CENTS).toBe(37.5);
  });

  it('maps a reading outside tolerance but inside the close/out boundary to close', () => {
    // 25c default tolerance, 37.5c close/out boundary -- 30c off is
    // out-of-tune but still "close", not "out".
    const reading = readingAt(440 * 2 ** (30 / 1200));
    expectReading(reading);
    expect(reading.inTune).toBe(false);
    expect(toneFor(reading)).toBe('close');
  });

  it('maps a reading beyond the close/out boundary to out', () => {
    const reading = readingAt(440 * 2 ** (45 / 1200));
    expectReading(reading);
    expect(reading.inTune).toBe(false);
    expect(toneFor(reading)).toBe('out');
  });

  it('treats a reading exactly at the close/out boundary as close (inclusive)', () => {
    const reading = readingAt(440 * 2 ** (37.5 / 1200));
    expectReading(reading);
    expect(toneFor(reading)).toBe('close');
  });
});

describe('formatCents', () => {
  it('formats positive and negative values with an explicit sign, rounded to an integer', () => {
    expect(formatCents(12.4)).toBe('+12c');
    expect(formatCents(-3.6)).toBe('-4c');
  });

  it('always shows a leading "+" for zero, including a value that rounds to negative zero', () => {
    expect(formatCents(0)).toBe('+0c');
    expect(formatCents(-0.2)).toBe('+0c'); // Math.round(-0.2) === -0, but the sign check must still read '+'
  });
});

describe('formatFrequencyHz', () => {
  it('formats to exactly two decimal places with a Hz suffix', () => {
    expect(formatFrequencyHz(440)).toBe('440.00Hz');
    expect(formatFrequencyHz(440.019)).toBe('440.02Hz');
  });
});

describe('needlePercent', () => {
  it('centers a zero-cents reading at 50%', () => {
    expect(needlePercent(0)).toBe(50);
  });

  it('maps +/-50c to the two track edges', () => {
    expect(needlePercent(50)).toBe(100);
    expect(needlePercent(-50)).toBe(0);
  });

  it('maps a value inside the range linearly', () => {
    expect(needlePercent(25)).toBe(75);
    expect(needlePercent(-10)).toBe(40);
  });

  it('clamps beyond +/-50c instead of running off the track', () => {
    expect(needlePercent(500)).toBe(100);
    expect(needlePercent(-500)).toBe(0);
  });
});

describe('inTuneZoneBounds', () => {
  it('derives the zone from the default packages/core tolerance (25c)', () => {
    expect(inTuneZoneBounds()).toEqual({ leftPercent: 25, widthPercent: 50 });
  });

  it('derives the zone from a custom tolerance', () => {
    expect(inTuneZoneBounds(10)).toEqual({ leftPercent: 40, widthPercent: 20 });
  });

  it('clamps an out-of-range tolerance rather than producing a nonsensical zone', () => {
    expect(inTuneZoneBounds(1000)).toEqual({ leftPercent: 0, widthPercent: 100 });
    expect(inTuneZoneBounds(-10)).toEqual({ leftPercent: 50, widthPercent: 0 });
  });
});

describe('formatForDebug', () => {
  it('formats no-signal/unclear', () => {
    expect(formatForDebug(NO_SIGNAL)).toBe('no signal');
    expect(formatForDebug(UNCLEAR)).toBe('unclear');
  });

  it('formats an in-tune reading with note, signed cents, frequency, and the "[in tune]" suffix', () => {
    const reading = readingAt(440);
    expectReading(reading);
    expect(reading.note.label).toBe('A4');
    expect(formatForDebug(reading)).toBe(`A4 +0c (${reading.frequencyHz.toFixed(2)}Hz) [in tune]`);
  });

  it('omits the "[in tune]" suffix when out of tune', () => {
    const reading = readingAt(440 * 2 ** (45 / 1200));
    expectReading(reading);
    expect(reading.note.label).toBe('A4');
    expect(reading.inTune).toBe(false);
    expect(formatForDebug(reading)).toBe(`A4 +45c (${reading.frequencyHz.toFixed(2)}Hz)`);
  });
});
