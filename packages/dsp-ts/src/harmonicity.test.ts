import { describe, expect, it } from 'vitest';
import { computeHarmonicity } from './harmonicity.js';

const SAMPLE_RATE = 44100;

function sineFrame(frequencyHz: number, numSamples: number): Float32Array {
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
  }
  return out;
}

describe('computeHarmonicity', () => {
  it('reports high periodicity / high HNR for a clean periodic tone at its true period', () => {
    const frequencyHz = 440;
    const frame = sineFrame(frequencyHz, 2048);
    const periodSamples = SAMPLE_RATE / frequencyHz;
    const result = computeHarmonicity(frame, frame.length, periodSamples);
    expect(result.normalizedPeriodicity).toBeGreaterThan(0.95);
    expect(result.harmonicToNoiseRatioDb).toBeGreaterThan(10);
  });

  it('reports low periodicity / floor HNR for white noise', () => {
    let seed = 42;
    const frame = new Float32Array(2048);
    for (let i = 0; i < frame.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      frame[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const result = computeHarmonicity(frame, frame.length, SAMPLE_RATE / 440);
    expect(result.normalizedPeriodicity).toBeLessThan(0.3);
    expect(result.harmonicToNoiseRatioDb).toBeLessThan(0);
  });

  it('floors at -20dB for a non-positive or out-of-range period', () => {
    const frame = sineFrame(440, 2048);
    expect(computeHarmonicity(frame, frame.length, 0).harmonicToNoiseRatioDb).toBe(-20);
    expect(computeHarmonicity(frame, frame.length, -5).harmonicToNoiseRatioDb).toBe(-20);
    expect(computeHarmonicity(frame, frame.length, frame.length + 10).harmonicToNoiseRatioDb).toBe(
      -20,
    );
  });

  it('floors at -20dB for too-short buffers', () => {
    const tiny = new Float32Array(2);
    expect(computeHarmonicity(tiny, tiny.length, 1).harmonicToNoiseRatioDb).toBe(-20);
  });
});
