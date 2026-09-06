import { describe, expect, it } from 'vitest';
import { analyzeTunerReading, type FingerTunerReading } from './finger-tuner.js';
import {
  DEFAULT_TUNER_SMOOTHING_WINDOW_MS,
  TunerDisplaySmoother,
  type SmoothedTunerReading,
} from './tuner-display-smoother.js';

const A4_HZ = 440;
// Exactly 5 semitones (a perfect fourth, 500 cents) above A4 -- MIDI 74.
const D5_HZ = A4_HZ * 2 ** (5 / 12);

const NO_SIGNAL: FingerTunerReading = { status: 'no-signal' };
const UNCLEAR: FingerTunerReading = { status: 'unclear' };

/** Builds a realistic 'reading'-status FingerTunerReading via the real analyzeTunerReading, rather than hand-rolling one -- keeps these tests honest about the actual input contract. */
function readingAt(frequencyHz: number, confidence = 0.9): FingerTunerReading {
  return analyzeTunerReading({ voiced: true, frequencyHz, confidence });
}

function hzAtCentsOffset(baseHz: number, cents: number): number {
  return baseHz * 2 ** (cents / 1200);
}

function expectReading(
  result: SmoothedTunerReading,
): asserts result is Extract<SmoothedTunerReading, { status: 'reading' }> {
  expect(result.status).toBe('reading');
}

describe('TunerDisplaySmoother', () => {
  describe('vibrato', () => {
    it('keeps a vibrated note tonally stable instead of flickering in/out of tune', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      const totalMs = 1000;
      const vibratoHz = 6; // middle of the cited 5-7Hz range
      const depthCents = 30; // top of the cited 10-30c range

      const rawCentsSeries: number[] = [];
      const smoothedCentsSeries: number[] = [];
      let anyRawOutOfTune = false;

      for (let t = 0; t <= totalMs; t += hopMs) {
        const offsetCents = depthCents * Math.sin((2 * Math.PI * vibratoHz * t) / 1000);
        const hz = hzAtCentsOffset(A4_HZ, offsetCents);

        const raw = readingAt(hz);
        expectReading(raw);
        rawCentsSeries.push(raw.cents);
        if (!raw.inTune) anyRawOutOfTune = true;

        const smoothed = smoother.update(raw, t);
        expectReading(smoothed);
        smoothedCentsSeries.push(smoothed.cents);
      }

      // Sanity check on the synthetic signal itself: confirm the raw vibrato
      // really does occasionally flicker out of tune before checking that
      // smoothing fixes it -- otherwise the test below could pass vacuously.
      expect(anyRawOutOfTune).toBe(true);

      // Skip the initial window-fill-in period: the smoothed value is only
      // averaged over a fully-populated window from here on (see the class
      // doc comment's "Vibrato / normal jitter" section).
      const warmupSamples = Math.ceil(DEFAULT_TUNER_SMOOTHING_WINDOW_MS / hopMs);
      const settledSmoothed = smoothedCentsSeries.slice(warmupSamples);
      const settledRaw = rawCentsSeries.slice(warmupSamples);

      // The actual user-facing bug this class exists to fix: once the
      // window is warmed up, the smoothed reading never flickers out of
      // tune even though the raw signal does throughout.
      expect(settledSmoothed.every((cents) => Math.abs(cents) <= 25)).toBe(true);

      // And the fix is real attenuation, not a coincidence: the smoothed
      // peak-to-peak swing is meaningfully smaller than the raw swing.
      const swing = (values: number[]) => Math.max(...values) - Math.min(...values);
      expect(swing(settledSmoothed)).toBeLessThan(swing(settledRaw) * 0.7);
    });

    it('is not just clipping the numbers -- the average sits near the true center of oscillation', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      const vibratoHz = 6;
      const depthCents = 25;
      let lastSmoothed: SmoothedTunerReading | undefined;

      for (let t = 0; t <= 600; t += hopMs) {
        const offsetCents = depthCents * Math.sin((2 * Math.PI * vibratoHz * t) / 1000);
        lastSmoothed = smoother.update(readingAt(hzAtCentsOffset(A4_HZ, offsetCents)), t);
      }

      expectReading(lastSmoothed!);
      expect(lastSmoothed.note.label).toBe('A4');
      // Well inside the residual-swing band computed in the test above, and
      // nowhere near the +/-25c depth of the raw oscillation.
      expect(Math.abs(lastSmoothed.cents)).toBeLessThan(15);
    });
  });

  describe('genuine pitch transitions', () => {
    it('snaps to a new note immediately on an abrupt jump, rather than smearing across it', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      let t = 0;
      let lastBeforeJump: SmoothedTunerReading | undefined;

      for (let i = 0; i < 30; i++) {
        lastBeforeJump = smoother.update(readingAt(A4_HZ), t);
        t += hopMs;
      }

      expectReading(lastBeforeJump!);
      expect(lastBeforeJump.note.label).toBe('A4');
      expect(Math.abs(lastBeforeJump.cents)).toBeLessThan(1);

      // Abrupt jump: a perfect fourth up, arriving in a single hop -- no
      // gradual slide, as if the player stopped one note and immediately
      // bowed a different string.
      const firstAfterJump = smoother.update(readingAt(D5_HZ), t);
      t += hopMs;
      expectReading(firstAfterJump);
      expect(firstAfterJump.note.label).toBe('D5');
      expect(Math.abs(firstAfterJump.cents)).toBeLessThan(5);

      // Confirm it stays there -- a real transition, not a one-hop blip.
      const secondAfterJump = smoother.update(readingAt(D5_HZ), t);
      expectReading(secondAfterJump);
      expect(secondAfterJump.note.label).toBe('D5');
      expect(Math.abs(secondAfterJump.cents)).toBeLessThan(1);
    });

    it('tracks a continuous slide to a new note within a bounded number of hops, rather than never arriving', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      const slideSteps = 20; // a 200ms slide from A4 to D5
      let t = 0;
      let last: SmoothedTunerReading | undefined;

      for (let i = 0; i <= slideSteps; i++) {
        const cents = (500 * i) / slideSteps; // 0 -> 500 cents (A4 -> D5)
        last = smoother.update(readingAt(hzAtCentsOffset(A4_HZ, cents)), t);
        t += hopMs;
      }
      // Hold the arrival note steady afterward so the average has a chance
      // to fully settle on it.
      for (let i = 0; i < 10; i++) {
        last = smoother.update(readingAt(D5_HZ), t);
        t += hopMs;
      }

      expectReading(last!);
      expect(last.note.label).toBe('D5');
      expect(Math.abs(last.cents)).toBeLessThan(5);
    });
  });

  describe('no-signal / unclear passthrough', () => {
    it('passes no-signal through unsmoothed', () => {
      const smoother = new TunerDisplaySmoother();
      expect(smoother.update(NO_SIGNAL, 0)).toEqual({ status: 'no-signal' });
    });

    it('passes unclear through unsmoothed', () => {
      const smoother = new TunerDisplaySmoother();
      expect(smoother.update(UNCLEAR, 0)).toEqual({ status: 'unclear' });
    });

    it('clears its window across a dropout, so the note after a gap is not blended with the note before it', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      let t = 0;

      for (let i = 0; i < 20; i++) {
        smoother.update(readingAt(A4_HZ), t);
        t += hopMs;
      }

      // A brief silence gap between notes (bow lift / re-articulation).
      const duringGap = smoother.update(NO_SIGNAL, t);
      expect(duringGap).toEqual({ status: 'no-signal' });
      t += hopMs;

      const firstAfterGap = smoother.update(readingAt(D5_HZ), t);
      expectReading(firstAfterGap);
      expect(firstAfterGap.note.label).toBe('D5');
      expect(Math.abs(firstAfterGap.cents)).toBeLessThan(5);
    });

    it('does not let a transient unclear blip mid-note leave a permanently wrong average -- it just re-settles on the same note', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      let t = 0;

      for (let i = 0; i < 15; i++) {
        smoother.update(readingAt(A4_HZ), t);
        t += hopMs;
      }
      smoother.update(UNCLEAR, t);
      t += hopMs;

      const afterBlip = smoother.update(readingAt(A4_HZ), t);
      expectReading(afterBlip);
      expect(afterBlip.note.label).toBe('A4');
      expect(Math.abs(afterBlip.cents)).toBeLessThan(1);
    });
  });

  describe('configuration', () => {
    it('resolves note/cents against its own configured a4Hz, independent of the input reading’s own a4Hz', () => {
      // readingAt() below produces raw note/cents computed against
      // analyzeTunerReading's default a4Hz (440) -- the smoother must
      // ignore that and use only frequencyHz, re-deriving note/cents
      // against its own configured a4Hz (442) instead.
      const smoother = new TunerDisplaySmoother({ a4Hz: 442 });
      const result = smoother.update(readingAt(442), 0);
      expectReading(result);
      expect(result.note.label).toBe('A4');
      expect(result.cents).toBe(0);
    });

    it('respects a lower transitionThresholdCents by snapping to smaller jumps', () => {
      const smoother = new TunerDisplaySmoother({ a4Hz: 442, transitionThresholdCents: 10 });
      const first = smoother.update(readingAt(442), 0);
      expectReading(first);
      expect(first.cents).toBe(0);

      // A 20c jump would be absorbed into the moving average under the
      // default 50c threshold, but should be treated as a transition (and
      // therefore fully reflected, not partially averaged away) once the
      // threshold is lowered to 10c.
      const jumped = smoother.update(readingAt(hzAtCentsOffset(442, 20)), 10);
      expectReading(jumped);
      expect(Math.abs(jumped.cents - 20)).toBeLessThan(0.5);
    });
  });

  describe('reset', () => {
    it('clears history so a subsequent reading is not blended with pre-reset samples', () => {
      const smoother = new TunerDisplaySmoother();
      const hopMs = 10;
      let t = 0;

      for (let i = 0; i < 20; i++) {
        smoother.update(readingAt(A4_HZ), t);
        t += hopMs;
      }
      smoother.reset();

      const afterReset = smoother.update(readingAt(D5_HZ), t);
      expectReading(afterReset);
      expect(afterReset.note.label).toBe('D5');
      expect(Math.abs(afterReset.cents)).toBeLessThan(1);
    });
  });
});
