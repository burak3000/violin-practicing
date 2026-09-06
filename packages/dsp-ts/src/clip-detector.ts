/**
 * Sustained input-gain-clipping detector -- built in apps/desktop's Phase 3
 * (task point 4, "surface an input-gain-clipping warning: peak/RMS near
 * 0dBFS sustained"), promoted into this shared package in Phase 4 so
 * apps/mobile can reuse the same logic. This is NOT a port of anything in
 * packages/dsp-native: Phase 1's validation harness only ever read
 * pre-recorded WAV files, so it never had a live input-gain knob to reason
 * about. New logic, specific to live capture, platform-agnostic by
 * construction (pure sample-array math, no DOM/Node/RN dependency).
 */

/** Mirrors onset-detector.ts's silence floor convention for an all-zero/empty buffer. */
const PEAK_FLOOR_DBFS = -120;

export interface ClipDetectorConfig {
  /** Peak level (dBFS) considered "near 0dBFS". */
  readonly clipPeakDbfs: number;
  /** Consecutive hops at/above clipPeakDbfs required before flagging -- guards against one hot transient (e.g. a pizzicato pluck) reading as sustained clipping. */
  readonly sustainedFrames: number;
}

export const DEFAULT_CLIP_DETECTOR_CONFIG: ClipDetectorConfig = Object.freeze({
  // A hair below true 0dBFS (peak amplitude 1.0): by the time a waveform
  // is *sample-exact* at full scale it has usually already been clipping
  // for a few samples, so warning slightly before hard 0dBFS gives the
  // player a chance to back off the input gain before the signal is
  // audibly distorted.
  clipPeakDbfs: -1.0,
  // Same "consecutive-frames" convention as OnsetSegmenter's stability
  // confirmation (see onset-detector.ts).
  sustainedFrames: 3,
});

/** Peak level in dBFS (full-scale amplitude 1.0 == 0dBFS), floored like computeRmsDbfs rather than -Infinity for silence. */
export function computePeakDbfs(
  samples: Float32Array,
  numSamples: number = samples.length,
): number {
  let peak = 0;
  for (let i = 0; i < numSamples; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) {
      peak = abs;
    }
  }
  if (peak <= 0) {
    return PEAK_FLOOR_DBFS;
  }
  return Math.max(PEAK_FLOOR_DBFS, 20 * Math.log10(peak));
}

/**
 * Stateful/stream-oriented like OnsetSegmenter: call `update` once per
 * analysis hop, in order. One instance per capture session.
 */
export class ClipDetector {
  private readonly config: ClipDetectorConfig;
  private consecutiveHotFrames = 0;

  constructor(config: ClipDetectorConfig = DEFAULT_CLIP_DETECTOR_CONFIG) {
    this.config = config;
  }

  /** Feed one hop's peak dBFS (see computePeakDbfs). Returns true on frames where sustained clipping is currently in effect. */
  update(peakDbfs: number): boolean {
    if (peakDbfs >= this.config.clipPeakDbfs) {
      this.consecutiveHotFrames += 1;
    } else {
      this.consecutiveHotFrames = 0;
    }
    return this.consecutiveHotFrames >= this.config.sustainedFrames;
  }

  reset(): void {
    this.consecutiveHotFrames = 0;
  }
}
