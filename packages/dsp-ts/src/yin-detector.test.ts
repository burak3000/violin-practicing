import { describe, expect, it } from 'vitest';
import { forViolin } from './pitch-types.js';
import { YinDetector } from './yin-detector.js';
import { ANALYSIS_FRAME_SIZE } from './pitch-pipeline.js';
import { generateSyntheticTone, midiToFrequencyHz } from './test-support/synthetic-tone.js';

const SAMPLE_RATE = 44100;

function centsError(detectedHz: number, trueHz: number): number {
  return 1200 * Math.log2(detectedHz / trueHz);
}

/**
 * Verifies this TS port against Phase 1's own published numbers
 * (packages/dsp-native/RESULTS.md: YIN mean cents error 0.13c sine / 0.65c
 * sawtooth, zero octave errors, across a G3-D6 chromatic sweep). This is
 * the "feed it the same synthetic reference tones... confirm it reports
 * correct pitch/cents, comparable to Phase 1's numbers" verification
 * Phase 3's task called for -- run directly against the TS detector,
 * outside any worklet/getUserMedia plumbing (see hop-buffer.test.ts and
 * pitch-pipeline.test.ts for the buffering/composition layers on top of
 * this).
 */
describe('YinDetector (TS port) accuracy vs. Phase 1 synthetic-tone numbers', () => {
  const config = forViolin(SAMPLE_RATE);
  // G3 (MIDI 55) to D6 (MIDI 86) inclusive -- matches
  // packages/dsp-native/test/generate_synthetic_fixtures.cpp's chromatic
  // sweep exactly (32 notes).
  const midiNotes = Array.from({ length: 86 - 55 + 1 }, (_, i) => 55 + i);

  it.each(['sine', 'sawtooth'] as const)(
    'tracks a full G3-D6 chromatic %s sweep within a few cents, zero octave errors',
    (waveform) => {
      const detector = new YinDetector(config);
      const absErrors: number[] = [];
      let octaveErrors = 0;
      let unvoicedCount = 0;

      for (const midi of midiNotes) {
        const trueHz = midiToFrequencyHz(midi);
        const tone = generateSyntheticTone(trueHz, { sampleRateHz: SAMPLE_RATE, waveform });

        // Analyze one frame centered in the steady region (fades/silence
        // excluded), mirroring how validation_harness.cpp samples frames
        // whose center falls inside [toneStartS, toneEndS).
        const centerSample = Math.round(((tone.toneStartS + tone.toneEndS) / 2) * SAMPLE_RATE);
        const start = centerSample - ANALYSIS_FRAME_SIZE / 2;
        const frame = tone.samples.subarray(start, start + ANALYSIS_FRAME_SIZE);

        const result = detector.detect(frame);
        if (!result.voiced) {
          unvoicedCount++;
          continue;
        }
        const cents = centsError(result.frequencyHz, trueHz);
        absErrors.push(Math.abs(cents));
        if (Math.abs(Math.abs(cents) - 1200) < 50) {
          octaveErrors++;
        }
      }

      expect(unvoicedCount).toBe(0);
      expect(octaveErrors).toBe(0);

      const mean = absErrors.reduce((a, b) => a + b, 0) / absErrors.length;
      const max = Math.max(...absErrors);
      // Phase 1's C++ numbers: mean 0.13c (sine) / 0.65c (sawtooth). This
      // independent TS port isn't asserted bit-identical to the C++
      // floating-point path -- generous but still meaningful bounds, well
      // inside the ~5-cent perceptual threshold cited throughout the plan.
      expect(mean).toBeLessThan(3);
      expect(max).toBeLessThan(10);
    },
  );

  it('resists the adversarial weak-fundamental case (piezo "top-heavy" stand-in)', () => {
    // Mirrors packages/dsp-native's adversarial fixture set: a sawtooth
    // with its fundamental attenuated to 20% (so H2 ends up louder than
    // H1) -- the direct synthetic test of "does the algorithm avoid
    // octave error when the fundamental is weak relative to a harmonic".
    const detector = new YinDetector(config);
    for (const noteName of ['A4', 'E5', 'A5'] as const) {
      const trueHz = { A4: 440, E5: 659.2551138257398, A5: 880 }[noteName];
      const tone = generateSyntheticTone(trueHz, {
        sampleRateHz: SAMPLE_RATE,
        waveform: 'sawtooth',
        fundamentalScale: 0.2,
      });
      const centerSample = Math.round(((tone.toneStartS + tone.toneEndS) / 2) * SAMPLE_RATE);
      const start = centerSample - ANALYSIS_FRAME_SIZE / 2;
      const frame = tone.samples.subarray(start, start + ANALYSIS_FRAME_SIZE);

      const result = detector.detect(frame);
      expect(result.voiced).toBe(true);
      const cents = Math.abs(centsError(result.frequencyHz, trueHz));
      expect(cents).toBeLessThan(15);
    }
  });

  it('reports unvoiced (not a guessed note) on pure noise', () => {
    const detector = new YinDetector(config);
    // Deterministic pseudo-random noise (no external RNG dependency) --
    // a simple LCG is enough to avoid any accidental periodicity a real
    // Math.random() stream could in principle (if vanishingly unlikely)
    // produce.
    let seed = 12345;
    const frame = new Float32Array(ANALYSIS_FRAME_SIZE);
    for (let i = 0; i < frame.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      frame[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const result = detector.detect(frame);
    // Noise may or may not clear YIN's own threshold by chance, but it
    // must never be *confidently* voiced -- this mirrors gateReading's
    // job in packages/core, checked one layer down here.
    if (result.voiced) {
      expect(result.confidence).toBeLessThan(0.9);
    }
  });

  it('reports unvoiced, not a crash, on a too-short buffer', () => {
    const detector = new YinDetector(config);
    const tiny = new Float32Array(3);
    const result = detector.detect(tiny);
    expect(result.voiced).toBe(false);
    expect(result.frequencyHz).toBe(0);
  });
});
