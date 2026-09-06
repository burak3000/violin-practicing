import { describe, expect, it } from 'vitest';
import { computeRmsDbfs, DEFAULT_ONSET_CONFIG, OnsetSegmenter } from './onset-detector.js';

describe('computeRmsDbfs', () => {
  it('floors an all-silent buffer', () => {
    expect(computeRmsDbfs(new Float32Array(512))).toBe(-120);
  });

  it('reports ~-3.01dBFS for a full-scale sine (RMS = amplitude/sqrt(2))', () => {
    const n = 4096;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = Math.sin((2 * Math.PI * 100 * i) / 44100);
    }
    expect(computeRmsDbfs(samples)).toBeCloseTo(-3.01, 1);
  });

  it('is louder for a louder signal', () => {
    const quiet = new Float32Array(1024).fill(0.01);
    const loud = new Float32Array(1024).fill(0.5);
    expect(computeRmsDbfs(loud)).toBeGreaterThan(computeRmsDbfs(quiet));
  });
});

describe('OnsetSegmenter', () => {
  it('starts silent and stays silent while below the RMS gate', () => {
    const segmenter = new OnsetSegmenter();
    expect(segmenter.state).toBe('silence');
    const event = segmenter.processFrame(-80, false, 0);
    expect(event.state).toBe('silence');
    expect(event.noteOnset).toBe(false);
    expect(event.noteOffset).toBe(false);
  });

  it('goes silence -> attack -> sustained exactly once on a clean, stable tone entering from silence', () => {
    const segmenter = new OnsetSegmenter();
    const states: string[] = [];
    let onsets = 0;

    // Two frames of silence.
    for (let i = 0; i < 2; i++) {
      const e = segmenter.processFrame(-80, false, 0);
      states.push(e.state);
    }
    // Enough stable-frequency, above-silence frames to satisfy
    // stabilityConfirmFrames (default 3).
    for (let i = 0; i < 6; i++) {
      const e = segmenter.processFrame(-20, true, 440);
      states.push(e.state);
      if (e.noteOnset) onsets++;
    }

    expect(onsets).toBe(1);
    expect(states.at(-1)).toBe('sustained');
    expect(states.filter((s) => s === 'silence')).toHaveLength(2);
  });

  it('does not confirm sustained if frequency is jumping around (unstable) even though it stays loud', () => {
    const segmenter = new OnsetSegmenter();
    segmenter.processFrame(-80, false, 0);
    // Wildly different frequencies each frame -- should never stabilize.
    const freqs = [440, 660, 220, 880, 330, 550];
    let onsets = 0;
    for (const f of freqs) {
      const e = segmenter.processFrame(-20, true, f);
      if (e.noteOnset) onsets++;
    }
    expect(onsets).toBe(0);
    expect(segmenter.state).toBe('attack');
  });

  it("emits exactly one onset and one offset for a silence -> tone -> silence sequence (mirrors Phase 1's synthetic-fixture finding)", () => {
    const segmenter = new OnsetSegmenter();
    let onsets = 0;
    let offsets = 0;

    for (let i = 0; i < 5; i++) {
      const e = segmenter.processFrame(-80, false, 0);
      if (e.noteOnset) onsets++;
      if (e.noteOffset) offsets++;
    }
    for (let i = 0; i < 20; i++) {
      const e = segmenter.processFrame(-15, true, 293.66);
      if (e.noteOnset) onsets++;
      if (e.noteOffset) offsets++;
    }
    for (let i = 0; i < 5; i++) {
      const e = segmenter.processFrame(-80, false, 0);
      if (e.noteOnset) onsets++;
      if (e.noteOffset) offsets++;
    }

    expect(onsets).toBe(1);
    expect(offsets).toBe(1);
  });

  it('closes out the previous note and re-attacks on a big energy rise while already sustained (slurred note change)', () => {
    const segmenter = new OnsetSegmenter();
    for (let i = 0; i < 5; i++) segmenter.processFrame(-20, true, 440);
    expect(segmenter.state).toBe('sustained');

    // Big RMS jump (>= onsetRiseDb) with no intervening silence.
    const event = segmenter.processFrame(-20 + DEFAULT_ONSET_CONFIG.onsetRiseDb + 1, true, 660);
    expect(event.noteOffset).toBe(true);
    expect(event.state).toBe('attack');
  });

  it('never guesses a note while unvoiced, even above the silence gate (bow noise / scratch)', () => {
    const segmenter = new OnsetSegmenter();
    let onsets = 0;
    for (let i = 0; i < 10; i++) {
      const e = segmenter.processFrame(-20, false, 0);
      if (e.noteOnset) onsets++;
    }
    expect(onsets).toBe(0);
  });
});
