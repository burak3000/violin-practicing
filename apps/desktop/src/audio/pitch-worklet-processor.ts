/**
 * Runs inside AudioWorkletGlobalScope -- own real-time thread, no DOM, no
 * Node.js APIs, no native addons (see audioworklet-globals.d.ts and
 * apps/desktop/CLAUDE.md's "DSP binding decision" section for the full
 * reasoning behind Phase 3's TS-port choice, made specifically in view of
 * this constraint). Everything imported here from `@violin/dsp-ts` is
 * plain, dependency-free TypeScript for exactly this reason -- it has to
 * be safe to run in this restricted scope. That package was built inside
 * this app during Phase 3 and promoted into a shared workspace package in
 * Phase 4 (see packages/dsp-ts/CLAUDE.md) so apps/mobile can reuse the
 * identical, already-validated pipeline; nothing about this file's own
 * worklet-scope behavior changed in that move -- TypeScript still pulls
 * `@violin/dsp-ts`'s source into THIS file's tsconfig.worklet.json
 * compilation transitively (see that file's own comment), so the
 * no-DOM/no-Node enforcement below is exactly as strict as when this code
 * lived at a relative `../dsp/*` path.
 *
 * Typechecked ONLY via tsconfig.worklet.json (see that file and
 * audioworklet-globals.d.ts) -- deliberately excluded from the main
 * tsconfig.json's DOM-lib project.
 */

import {
  forViolin,
  PitchAnalysisPipeline,
  ANALYSIS_FRAME_SIZE,
  ANALYSIS_HOP_SIZE,
  HopBuffer,
} from '@violin/dsp-ts';
import { PITCH_PROCESSOR_NAME, type WorkletAnalysisMessage } from './worklet-messages.js';

class PitchProcessor extends AudioWorkletProcessor {
  private readonly hopBuffer = new HopBuffer(ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE);
  private readonly pipeline: PitchAnalysisPipeline;

  constructor() {
    super();
    // `sampleRate` is a real global inside AudioWorkletGlobalScope (the
    // owning AudioContext's sample rate) -- see audioworklet-globals.d.ts.
    this.pipeline = new PitchAnalysisPipeline(forViolin(sampleRate));
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      // Nothing connected yet (or a temporarily silent/disconnected
      // input) -- keep the processor alive rather than exiting; there is
      // nothing to analyze this render quantum.
      return true;
    }
    // Mono: violin pitch detection is monophonic by design (see root
    // CLAUDE.md) -- channel 0 is all we need even if more were connected.
    const channel = input[0];

    for (const frame of this.hopBuffer.push(channel)) {
      const startMs = performance.now();
      const result = this.pipeline.analyzeFrame(frame);
      const computeTimeMs = performance.now() - startMs;

      const message: WorkletAnalysisMessage = {
        type: 'analysis',
        contextTimeS: currentTime,
        workletTimestampMs: performance.now(),
        computeTimeMs,
        rmsDbfs: result.rmsDbfs,
        peakDbfs: result.peakDbfs,
        frequencyHz: result.frequencyHz,
        confidence: result.confidence,
        confirmedVoiced: result.confirmedVoiced,
        onsetState: result.onsetState,
        noteOnset: result.noteOnset,
        noteOffset: result.noteOffset,
        clipping: result.clipping,
        voiced: result.voiced,
      };
      this.port.postMessage(message);
    }

    return true; // keep processing for the AudioContext's lifetime
  }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
