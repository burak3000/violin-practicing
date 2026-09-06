import { describe, expect, it } from 'vitest';
import type { PitchReading } from '../scoring/scoring.js';
import { FingerTuner, analyzeTunerReading } from './finger-tuner.js';

const voiced = (frequencyHz: number, confidence = 0.9): PitchReading => ({
  voiced: true,
  frequencyHz,
  confidence,
});
const unvoiced: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

describe('analyzeTunerReading', () => {
  it('reports no-signal for an unvoiced reading', () => {
    expect(analyzeTunerReading(unvoiced)).toEqual({ status: 'no-signal' });
  });

  it('reports unclear for a voiced-but-low-confidence reading (never guesses a note)', () => {
    expect(analyzeTunerReading(voiced(440, 0.1))).toEqual({ status: 'unclear' });
  });

  it('reports unclear for a voiced, confident, but implausibly-out-of-range frequency', () => {
    expect(analyzeTunerReading(voiced(50, 0.95))).toEqual({ status: 'unclear' });
    expect(analyzeTunerReading(voiced(5000, 0.95))).toEqual({ status: 'unclear' });
  });

  it('reports an exact in-tune reading', () => {
    const result = analyzeTunerReading(voiced(440));
    expect(result).toMatchObject({ status: 'reading', inTune: true, frequencyHz: 440 });
    if (result.status === 'reading') {
      expect(result.note.label).toBe('A4');
      expect(result.cents).toBeCloseTo(0, 6);
    }
  });

  it('flags a note within tolerance as in-tune even if not exact', () => {
    const result = analyzeTunerReading(voiced(441)); // a few cents sharp, well within the 25c default
    expect(result).toMatchObject({ status: 'reading', inTune: true });
  });

  it('flags a note outside tolerance as not in-tune, while still naming the nearest note (continuous feedback, not a pass/fail gate)', () => {
    const result = analyzeTunerReading(voiced(450)); // ~+39c off A4: outside the 25c default tolerance
    expect(result).toMatchObject({ status: 'reading', inTune: false });
    if (result.status === 'reading') {
      expect(result.note.label).toBe('A4');
      expect(result.cents).toBeGreaterThan(25);
    }
  });

  it('shows a slide continuously rather than debouncing it (no dwell time / no memory across calls)', () => {
    // Simulate a portamento sweep from G4 up to A4 -- Finger Tuner should
    // name a different nearest note on consecutive calls immediately, with
    // nothing carried over between them (see module doc comment).
    const sweepHz = [392, 400, 415, 428, 440]; // G4 ... A4
    const notes = sweepHz.map((hz) => analyzeTunerReading(voiced(hz)));
    expect(notes.every((n) => n.status === 'reading')).toBe(true);
    const labels = notes.map((n) => (n.status === 'reading' ? n.note.label : undefined));
    expect(labels[0]).toBe('G4');
    expect(labels[labels.length - 1]).toBe('A4');
  });

  it('respects a4Hz and inTuneCentsTolerance overrides', () => {
    const result = analyzeTunerReading(voiced(442), { a4Hz: 442, inTuneCentsTolerance: 5 });
    expect(result).toMatchObject({ status: 'reading', inTune: true });

    const tightened = analyzeTunerReading(voiced(445), { inTuneCentsTolerance: 5 });
    expect(tightened).toMatchObject({ status: 'reading', inTune: false });
  });
});

describe('FingerTuner class', () => {
  it('is a thin stateless wrapper: repeated calls with the same reading give the same result', () => {
    const tuner = new FingerTuner();
    const reading = voiced(440);
    expect(tuner.analyze(reading)).toEqual(tuner.analyze(reading));
  });

  it('holds config across calls', () => {
    const tuner = new FingerTuner({ a4Hz: 442 });
    const result = tuner.analyze(voiced(442));
    expect(result).toMatchObject({ status: 'reading', inTune: true });
    if (result.status === 'reading') {
      expect(result.note.label).toBe('A4');
    }
  });
});
