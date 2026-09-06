/**
 * Faithful TypeScript port of packages/dsp-native's onset/silence
 * segmentation layer (`include/dsp_native/onset_detector.h` /
 * `src/onset_detector.cpp`): an RMS silence/noise gate, energy-rise attack
 * detection, and pitch-stability confirmation before a note onset is
 * accepted. Deliberately NOT spectral-flux based, mirroring dsp-native's
 * own documented reasoning: unneeded compute for this monophonic
 * bowed-string case, RMS envelope + the already-computed pitch stream is
 * enough signal.
 */

const SILENCE_FLOOR_DBFS = -120;

/** Mirrors `ComputeRmsDbfs`: RMS level in dBFS (full-scale sine at amplitude 1.0 == 0dBFS), floored rather than -Infinity for all-zero input. */
export function computeRmsDbfs(samples: Float32Array, numSamples: number = samples.length): number {
  if (numSamples === 0) {
    return SILENCE_FLOOR_DBFS;
  }
  let sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / numSamples);
  if (rms <= 0) {
    return SILENCE_FLOOR_DBFS;
  }
  return Math.max(SILENCE_FLOOR_DBFS, 20 * Math.log10(rms));
}

export interface OnsetConfig {
  /** RMS-envelope silence/noise gate: frames at or below this level are treated as silence regardless of what the pitch detector reported. Default matches dsp-native's "~-50dBFS default, configurable" and Phase 3's task point 4. */
  readonly silenceThresholdDbfs: number;
  /** A frame-to-frame RMS rise at or above this many dB, while not already Sustained, flags a new attack rather than being ignored as steady-state noise. */
  readonly onsetRiseDb: number;
  /** Consecutive voiced frames, all within stabilityCentsTolerance of their own mean, required before an Attack is promoted to a confirmed Sustained note. */
  readonly stabilityConfirmFrames: number;
  readonly stabilityCentsTolerance: number;
}

export const DEFAULT_ONSET_CONFIG: OnsetConfig = Object.freeze({
  silenceThresholdDbfs: -50,
  onsetRiseDb: 6,
  stabilityConfirmFrames: 3,
  stabilityCentsTolerance: 35,
});

export type FrameState = 'silence' | 'attack' | 'sustained';

export interface FrameEvent {
  readonly state: FrameState;
  /** true exactly on the frame a note is confirmed. */
  readonly noteOnset: boolean;
  /** true exactly on the frame a sustained note ends. */
  readonly noteOffset: boolean;
}

/**
 * Mirrors `OnsetSegmenter`: a small stateful stream processor. Feed it one
 * frame's RMS (dBFS) and gated pitch (voiced + frequency) per hop, in
 * order. Stateful and stream-oriented, not thread-safe (mirrors the C++
 * class's own documented constraint) -- one instance per capture session.
 */
export class OnsetSegmenter {
  private readonly config: OnsetConfig;
  private frameState: FrameState = 'silence';
  private recentVoicedHz: number[] = [];
  private lastRmsDbfs = -120;

  constructor(config: OnsetConfig = DEFAULT_ONSET_CONFIG) {
    this.config = config;
  }

  get state(): FrameState {
    return this.frameState;
  }

  private recentPitchIsStable(): boolean {
    if (this.recentVoicedHz.length < this.config.stabilityConfirmFrames) {
      return false;
    }
    const mean = this.recentVoicedHz.reduce((sum, f) => sum + f, 0) / this.recentVoicedHz.length;
    if (mean <= 0) {
      return false;
    }
    for (const f of this.recentVoicedHz) {
      const cents = 1200 * Math.log2(f / mean);
      if (Math.abs(cents) > this.config.stabilityCentsTolerance) {
        return false;
      }
    }
    return true;
  }

  /**
   * `pitchVoiced`/`frequencyHz` should already reflect the harmonicity
   * gate (the caller has already suppressed pitch output on low-HNR
   * frames, see harmonicity.ts) -- this class only adds the *temporal*
   * onset/offset/stability logic on top.
   */
  processFrame(rmsDbfs: number, pitchVoiced: boolean, frequencyHz: number): FrameEvent {
    const aboveSilence = rmsDbfs > this.config.silenceThresholdDbfs;
    const riseDb = rmsDbfs - this.lastRmsDbfs;
    this.lastRmsDbfs = rmsDbfs;

    let noteOnset = false;
    let noteOffset = false;

    if (!aboveSilence) {
      if (this.frameState === 'sustained') {
        noteOffset = true;
      }
      this.frameState = 'silence';
      this.recentVoicedHz = [];
      return { state: this.frameState, noteOnset, noteOffset };
    }

    // A big-enough energy rise while already Sustained means a new bow
    // attack started with no intervening silence (e.g. a slurred note
    // change) -- close out the previous note and re-open Attack so the new
    // pitch gets its own stability confirmation rather than silently
    // overwriting the previous note's duration.
    if (this.frameState === 'sustained' && riseDb >= this.config.onsetRiseDb) {
      noteOffset = true;
      this.frameState = 'attack';
      this.recentVoicedHz = [];
    } else if (this.frameState === 'silence') {
      this.frameState = 'attack';
      this.recentVoicedHz = [];
    }

    if (this.frameState === 'attack') {
      if (pitchVoiced && frequencyHz > 0) {
        this.recentVoicedHz.push(frequencyHz);
        while (this.recentVoicedHz.length > this.config.stabilityConfirmFrames) {
          this.recentVoicedHz.shift();
        }
      } else {
        this.recentVoicedHz = [];
      }
      if (this.recentPitchIsStable()) {
        this.frameState = 'sustained';
        noteOnset = true;
      }
    }

    return { state: this.frameState, noteOnset, noteOffset };
  }
}
