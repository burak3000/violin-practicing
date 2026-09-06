import { forViolin, type PitchDetectorConfig } from './pitch-types.js';
import { YinDetector } from './yin-detector.js';
import { computeHarmonicity, SILENT_HARMONICITY_RESULT } from './harmonicity.js';
import { computeRmsDbfs, OnsetSegmenter, type FrameState } from './onset-detector.js';
import { ClipDetector, computePeakDbfs } from './clip-detector.js';

/**
 * Analysis frame/hop size, matching packages/dsp-native's validated
 * settings exactly (see packages/dsp-native/CLAUDE.md's "Numbers"
 * section): 2048-sample frames (~46.4ms @ 44.1kHz), 512-sample hop
 * (~11.6ms, 75% overlap). Phase 1's timing/accuracy numbers were measured
 * at these sizes -- changing them here would mean downstream verification
 * is no longer comparable to Phase 1's budget, on either platform.
 */
export const ANALYSIS_FRAME_SIZE = 2048;
export const ANALYSIS_HOP_SIZE = 512;

/** Matches validation_harness.cpp's `kHnrGateDb` (periodic energy >= noise energy at the reported period). */
export const HNR_GATE_DB = 0.0;

export interface AnalysisFrameResult {
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
  readonly frequencyHz: number;
  readonly confidence: number;
  /** YIN's own `voiced` AND the harmonicity/HNR gate -- matches the validated harness's `confirmedVoiced` (see validation_harness.cpp's `AnalyzeFrame`). */
  readonly confirmedVoiced: boolean;
  readonly onsetState: FrameState;
  readonly noteOnset: boolean;
  readonly noteOffset: boolean;
  /** Sustained input-gain clipping -- see clip-detector.ts. */
  readonly clipping: boolean;
  /**
   * `confirmedVoiced` AND not currently RMS/onset-gated silent -- what
   * this pipeline's consumers feed to packages/core as `PitchReading.voiced`.
   * Deliberately does NOT additionally require `onsetState === 'sustained'`:
   * that would re-introduce exactly the kind of debounce/lag
   * packages/core's Finger Tuner is designed to avoid (see
   * packages/core/CLAUDE.md's Finger Tuner section -- "should show a
   * slide as it happens rather than debouncing it"). `onsetState` is still
   * exposed on this result for callers that *do* want the richer
   * silence/attack/sustained distinction (e.g. a future Playing Practice
   * dwell-time consumer).
   */
  readonly voiced: boolean;
}

/**
 * Owns one YinDetector + OnsetSegmenter + ClipDetector instance and runs
 * the exact per-hop pipeline packages/dsp-native's validation harness
 * validated (YIN -> harmonicity/HNR gate -> onset/silence segmentation --
 * see validation_harness.cpp's `AnalyzeFrame` and its `kHnrGateDb`), plus
 * a clip detector (new, live-input-specific logic -- the WAV-file harness
 * never had a live gain knob to reason about).
 *
 * Not thread-safe / not re-entrant (owns mutable scratch state, mirroring
 * every stateful class this composes) -- exactly one instance per capture
 * session. Platform-agnostic: apps/desktop drives this from inside a real
 * `AudioWorkletProcessor`; apps/mobile drives the same class from its
 * microphone capture callback (see each app's own audio/ glue and
 * CLAUDE.md for which delivery mechanism it uses and why).
 */
export class PitchAnalysisPipeline {
  readonly config: PitchDetectorConfig;
  private readonly yin: YinDetector;
  private readonly onset: OnsetSegmenter;
  private readonly clip: ClipDetector;

  constructor(config: PitchDetectorConfig = forViolin(44100)) {
    this.config = config;
    this.yin = new YinDetector(config);
    this.onset = new OnsetSegmenter();
    this.clip = new ClipDetector();
  }

  /** `frame` must be exactly ANALYSIS_FRAME_SIZE samples -- the trailing analysis window ending at the current hop boundary (see hop-buffer.ts). */
  analyzeFrame(frame: Float32Array): AnalysisFrameResult {
    const rmsDbfs = computeRmsDbfs(frame);
    const peakDbfs = computePeakDbfs(frame);
    const pitch = this.yin.detect(frame);

    const harmonicity = pitch.voiced
      ? computeHarmonicity(frame, frame.length, pitch.periodSamples)
      : SILENT_HARMONICITY_RESULT;
    const confirmedVoiced = pitch.voiced && harmonicity.harmonicToNoiseRatioDb >= HNR_GATE_DB;

    const onsetEvent = this.onset.processFrame(rmsDbfs, confirmedVoiced, pitch.frequencyHz);
    const clipping = this.clip.update(peakDbfs);

    return {
      rmsDbfs,
      peakDbfs,
      frequencyHz: pitch.frequencyHz,
      confidence: pitch.confidence,
      confirmedVoiced,
      onsetState: onsetEvent.state,
      noteOnset: onsetEvent.noteOnset,
      noteOffset: onsetEvent.noteOffset,
      clipping,
      voiced: confirmedVoiced && onsetEvent.state !== 'silence',
    };
  }
}
