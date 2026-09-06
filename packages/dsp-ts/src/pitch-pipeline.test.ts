import { describe, expect, it } from 'vitest';
import { analyzeTunerReading, type PitchReading } from '@violin/core';
import { forViolin } from './pitch-types.js';
import { ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE, PitchAnalysisPipeline } from './pitch-pipeline.js';
import { HopBuffer } from './hop-buffer.js';
import { generateSyntheticTone } from './test-support/synthetic-tone.js';

const SAMPLE_RATE = 44100;

/** Feeds a full synthetic tone through HopBuffer -> PitchAnalysisPipeline exactly as a real-time consumer does (128-sample chunks, matching desktop's worklet render quantum), returning every emitted frame's result in order. */
function runPipelineOverTone(samples: Float32Array) {
  const hopBuffer = new HopBuffer(ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE);
  const pipeline = new PitchAnalysisPipeline(forViolin(SAMPLE_RATE));
  const results = [];
  const RENDER_QUANTUM = 128;
  for (let offset = 0; offset < samples.length; offset += RENDER_QUANTUM) {
    const chunk = samples.subarray(offset, Math.min(offset + RENDER_QUANTUM, samples.length));
    for (const frame of hopBuffer.push(chunk)) {
      results.push(pipeline.analyzeFrame(frame));
    }
  }
  return results;
}

describe('PitchAnalysisPipeline end-to-end (HopBuffer -> YIN -> harmonicity gate -> onset segmentation -> clip)', () => {
  it('reports no-signal during the leading silence, then a stable A4 reading, then no-signal again after fade-out', () => {
    const tone = generateSyntheticTone(440, { sampleRateHz: SAMPLE_RATE, waveform: 'sine' });
    const results = runPipelineOverTone(tone.samples);

    expect(results.length).toBeGreaterThan(10);

    const firstResult = results[0];
    expect(firstResult.voiced).toBe(false);
    expect(firstResult.onsetState).toBe('silence');

    const lastResult = results.at(-1)!;
    expect(lastResult.voiced).toBe(false);

    // At least a solid run of confirmed-voiced, sustained frames somewhere
    // in the middle (the steady region), close to 440Hz.
    const sustainedFrames = results.filter((r) => r.onsetState === 'sustained' && r.voiced);
    expect(sustainedFrames.length).toBeGreaterThan(10);
    const sustainedCents = sustainedFrames.map((r) =>
      Math.abs(1200 * Math.log2(r.frequencyHz / 440)),
    );

    // Loose sanity bound on *every* sustained frame -- catches a genuinely
    // wrong reading (e.g. an octave error, ~1200c) without over-fitting to
    // the transition frames near either edge of the sustained run, where
    // the trailing 2048-sample (~46ms) analysis window still partially
    // overlaps the fixture's 50ms fade-in/fade-out ramps (a real, measured
    // windowing edge effect -- confirmed by tracing every sustained frame's
    // cents error during implementation: it settles to ~0.07c within ~6
    // hops of onset confirmation, stays there for the whole steady region,
    // then rises again over the last few hops before fade-out, peaking at
    // ~6.4c on the very last sustained-voiced frame. OnsetSegmenter only
    // needs 3 stable hops to confirm "sustained" and has no equivalent
    // early-warning for an *upcoming* offset, so neither edge is a bug).
    // yin-detector.test.ts already covers tight, steady-state-only accuracy
    // against Phase 1's numbers directly; this test's job is the
    // end-to-end wiring, not re-proving that.
    for (const cents of sustainedCents) {
      expect(cents).toBeLessThan(50);
    }
    // Tight tolerance once the window is solidly clear of both transitions
    // (trim enough hops off each end that a 2048-sample trailing window can
    // no longer reach into either 50ms fade -- ~46ms/11.6ms-per-hop plus
    // margin, confirmed against the traced curve above).
    const wellSettled = sustainedCents.slice(8, -8);
    expect(wellSettled.length).toBeGreaterThan(5);
    for (const cents of wellSettled) {
      expect(cents).toBeLessThan(5);
    }

    // Exactly one onset, one offset across the whole tone (matches Phase
    // 1's own synthetic-fixture finding for the C++ OnsetSegmenter).
    expect(results.filter((r) => r.noteOnset)).toHaveLength(1);
    expect(results.filter((r) => r.noteOffset)).toHaveLength(1);

    // No clipping: this tone is peak-normalized to 0.7, well under 0dBFS.
    expect(results.some((r) => r.clipping)).toBe(false);
  });

  it('flags sustained clipping on a hot (near full-scale) tone', () => {
    // Bypass the fixture's own 0.7 peak normalization by scaling back up
    // after generation, simulating an input-gain-too-hot condition.
    const tone = generateSyntheticTone(440, { sampleRateHz: SAMPLE_RATE, waveform: 'sine' });
    const hot = new Float32Array(tone.samples.length);
    for (let i = 0; i < hot.length; i++) {
      hot[i] = Math.max(-1, Math.min(1, tone.samples[i] * (1 / 0.7)));
    }
    const results = runPipelineOverTone(hot);
    expect(results.some((r) => r.clipping)).toBe(true);
  });

  it("wires a confirmed-voiced frame into packages/core's analyzeTunerReading as an in-tune A4 reading", () => {
    const tone = generateSyntheticTone(440, { sampleRateHz: SAMPLE_RATE, waveform: 'sine' });
    const results = runPipelineOverTone(tone.samples);
    const sustained = results.find((r) => r.onsetState === 'sustained' && r.voiced)!;
    expect(sustained).toBeDefined();

    const reading: PitchReading = {
      voiced: sustained.voiced,
      frequencyHz: sustained.frequencyHz,
      confidence: sustained.confidence,
    };
    const tunerReading = analyzeTunerReading(reading);

    expect(tunerReading.status).toBe('reading');
    if (tunerReading.status === 'reading') {
      expect(tunerReading.note.label).toBe('A4');
      expect(Math.abs(tunerReading.cents)).toBeLessThan(5);
      expect(tunerReading.inTune).toBe(true);
    }
  });

  it("wires the leading-silence frame into packages/core's analyzeTunerReading as no-signal", () => {
    const tone = generateSyntheticTone(440, { sampleRateHz: SAMPLE_RATE, waveform: 'sine' });
    const results = runPipelineOverTone(tone.samples);
    const silent = results[0];

    const reading: PitchReading = {
      voiced: silent.voiced,
      frequencyHz: silent.frequencyHz,
      confidence: silent.confidence,
    };
    expect(analyzeTunerReading(reading)).toEqual({ status: 'no-signal' });
  });
});
