// Barrel export for @violin/dsp-ts: the shared TypeScript port of
// packages/dsp-native's validated YIN pipeline. Built inside apps/desktop
// during Phase 3 (see apps/desktop/CLAUDE.md's "DSP binding decision" for
// why a TS port, not WASM/Node-addon, was chosen there); promoted into this
// standalone package in Phase 4 so apps/mobile can consume the exact same,
// already-validated pipeline instead of re-porting the algorithm a second
// time. See this package's own CLAUDE.md for the full picture.

export {
  DEFAULT_YIN_THRESHOLD,
  UNVOICED_PITCH_RESULT,
  VIOLIN_MAX_FREQUENCY_HZ,
  VIOLIN_MIN_FREQUENCY_HZ,
  forViolin,
  minRecommendedFrameSize,
} from './pitch-types.js';
export type { PitchDetectorConfig, PitchResult } from './pitch-types.js';

export { YinDetector } from './yin-detector.js';

export { DEFAULT_ONSET_CONFIG, OnsetSegmenter, computeRmsDbfs } from './onset-detector.js';
export type { FrameEvent, FrameState, OnsetConfig } from './onset-detector.js';

export { SILENT_HARMONICITY_RESULT, computeHarmonicity } from './harmonicity.js';
export type { HarmonicityResult } from './harmonicity.js';

export { ClipDetector, DEFAULT_CLIP_DETECTOR_CONFIG, computePeakDbfs } from './clip-detector.js';
export type { ClipDetectorConfig } from './clip-detector.js';

export { HopBuffer } from './hop-buffer.js';

export {
  ANALYSIS_FRAME_SIZE,
  ANALYSIS_HOP_SIZE,
  HNR_GATE_DB,
  PitchAnalysisPipeline,
} from './pitch-pipeline.js';
export type { AnalysisFrameResult } from './pitch-pipeline.js';
