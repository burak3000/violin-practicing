/**
 * Message shape posted from PitchProcessor (inside AudioWorkletGlobalScope
 * -- see audioworklet-globals.d.ts) to the main thread over
 * `AudioWorkletNode.port` / `AudioWorkletProcessor.port`. Pure data, no
 * DOM/Node dependency of its own -- safe to import from both the worklet
 * file (tsconfig.worklet.json) and main-thread code (tsconfig.json).
 */
export interface WorkletAnalysisMessage {
  readonly type: 'analysis';

  /**
   * AudioWorkletGlobalScope's `currentTime` (AudioContext clock, seconds)
   * as of the render quantum this hop's window completed in. NOT the same
   * clock as `performance.now()` -- only comparable to other
   * `currentTime`/`currentFrame` readings from the same AudioContext.
   */
  readonly contextTimeS: number;

  /**
   * `performance.now()` read inside the worklet immediately after this
   * hop's analysis finished. Chromium/Electron worklets share the same
   * time origin as the document that created the AudioContext, so this IS
   * meaningfully comparable to a `performance.now()` reading taken on the
   * main thread -- capture-pipeline.ts uses exactly that to estimate
   * worklet-to-main-thread relay latency. Documented as a reasonable,
   * but not spec-guaranteed-in-every-engine, assumption -- see
   * apps/desktop/CLAUDE.md's latency-measurement section.
   */
  readonly workletTimestampMs: number;

  /** Wall-clock time (ms) spent in this hop's YIN + harmonicity + onset + clip analysis -- directly comparable to packages/dsp-native/RESULTS.md's per-frame C++ timing numbers. */
  readonly computeTimeMs: number;

  readonly rmsDbfs: number;
  readonly peakDbfs: number;
  readonly frequencyHz: number;
  readonly confidence: number;
  /** YIN's own `voiced` AND the harmonicity/HNR gate -- see pitch-pipeline.ts. */
  readonly confirmedVoiced: boolean;
  readonly onsetState: 'silence' | 'attack' | 'sustained';
  readonly noteOnset: boolean;
  readonly noteOffset: boolean;
  /** Sustained input-gain clipping (task point 4). */
  readonly clipping: boolean;
  /** What capture-pipeline.ts/the debug UI should feed to packages/core as `PitchReading.voiced`. */
  readonly voiced: boolean;
}

export type WorkletOutMessage = WorkletAnalysisMessage;

/**
 * The `AudioWorkletProcessor` registration name -- shared between
 * pitch-worklet-processor.ts's `registerProcessor()` call and
 * capture-pipeline.ts's `new AudioWorkletNode(context, name)` call. Defined
 * once here (rather than duplicated as a string literal in both files,
 * which live in different tsconfig projects and can't share a normal
 * import the way most modules do) so the two can never drift apart.
 */
export const PITCH_PROCESSOR_NAME = 'pitch-processor';
