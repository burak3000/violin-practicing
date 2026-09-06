import { describe, expect, it } from 'vitest';
import { ClipDetector, computePeakDbfs, DEFAULT_CLIP_DETECTOR_CONFIG } from './clip-detector.js';

describe('computePeakDbfs', () => {
  it('floors an all-silent buffer', () => {
    expect(computePeakDbfs(new Float32Array(64))).toBe(-120);
  });

  it('reports ~0dBFS for a full-scale sample', () => {
    expect(computePeakDbfs(new Float32Array([0, 0.2, -1.0, 0.3]))).toBeCloseTo(0, 5);
  });

  it('reports the correct dB for a known sub-full-scale peak', () => {
    // 20*log10(0.5) ~= -6.02dB
    expect(computePeakDbfs(new Float32Array([0.5, -0.1]))).toBeCloseTo(-6.02, 1);
  });
});

describe('ClipDetector', () => {
  it('does not flag a single hot transient (e.g. a pluck)', () => {
    const clip = new ClipDetector();
    expect(clip.update(0)).toBe(false); // one hot frame
    expect(clip.update(-40)).toBe(false); // back to normal
  });

  it('flags sustained near-0dBFS input after the configured number of consecutive hot frames', () => {
    const clip = new ClipDetector();
    const n = DEFAULT_CLIP_DETECTOR_CONFIG.sustainedFrames;
    let flagged = false;
    for (let i = 0; i < n; i++) {
      flagged = clip.update(0);
    }
    expect(flagged).toBe(true);
  });

  it('clears once the input drops back below the clip threshold', () => {
    const clip = new ClipDetector();
    for (let i = 0; i < DEFAULT_CLIP_DETECTOR_CONFIG.sustainedFrames; i++) {
      clip.update(0);
    }
    expect(clip.update(-30)).toBe(false);
  });

  it('reset() clears accumulated hot-frame count', () => {
    const clip = new ClipDetector();
    clip.update(0);
    clip.update(0);
    clip.reset();
    expect(clip.update(0)).toBe(false);
  });
});
