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
   * `Date.now()` (epoch milliseconds) read inside the worklet immediately
   * after this hop's analysis finished. Date.now() rather than
   * performance.now() because `performance` does not exist in
   * AudioWorkletGlobalScope (see audioworklet-globals.d.ts). Epoch time is
   * shared by every thread of the process, so capture-pipeline.ts compares
   * this directly against its own Date.now() to estimate worklet-to-main
   * relay latency -- no cross-clock assumption at all, at the cost of 1ms
   * resolution. Also the monotonic-enough timestamp fed to packages/core's
   * TunerDisplaySmoother / PracticeAttemptTracker.
   */
  readonly workletTimestampMs: number;

  /** Wall-clock time (ms, Date.now() deltas -- 1ms resolution, so per-frame values read 0 or 1; the mean over many frames is what's meaningful) spent in this hop's YIN + harmonicity + onset + clip analysis. Compare the *mean* against packages/dsp-native/RESULTS.md's per-frame C++ timing numbers. */
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

  /** How many discrete channels the source delivered to the worklet this render quantum (e.g. 4 for a MiniFuse 1: 2 analog + 2 loopback). */
  readonly inputChannels: number;
  /** Zero-based index of the channel the worklet chose to analyze (the one carrying the most energy, with hysteresis). */
  readonly selectedChannel: number;
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
