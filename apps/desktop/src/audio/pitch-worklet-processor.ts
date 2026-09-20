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

/**
 * Hysteresis for channel selection: the currently selected channel is kept
 * as long as its energy is at least this fraction of the loudest channel's.
 * 0.5 == "switch only when another channel is more than ~3dB louder" --
 * enough that a mono input mirrored onto two channels (identical energy)
 * never flip-flops, while a selected channel that has gone silent (e.g. the
 * instrument was moved to a different input) is abandoned immediately.
 */
const CHANNEL_SWITCH_ENERGY_RATIO = 0.5;

class PitchProcessor extends AudioWorkletProcessor {
  private readonly hopBuffer = new HopBuffer(ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE);
  private readonly pipeline: PitchAnalysisPipeline;
  private selectedChannel = 0;

  constructor() {
    super();
    // `sampleRate` is a real global inside AudioWorkletGlobalScope (the
    // owning AudioContext's sample rate) -- see audioworklet-globals.d.ts.
    this.pipeline = new PitchAnalysisPipeline(forViolin(sampleRate));
  }

  /**
   * Picks the channel to analyze this render quantum. Pitch detection is
   * monophonic by design (see root CLAUDE.md), but the *source* may be a
   * multichannel interface where the instrument sits on any one input and
   * the rest are silent (an Arturia MiniFuse 1 exposes 4: 2 analog + 2 USB
   * loopback). Choosing by energy, with hysteresis, works for all of those
   * without configuration. Switching only ever happens between quanta, and
   * only toward a clearly louder channel, so a mirrored mono input (equal
   * energy on two channels) stays put and never audibly glitches.
   */
  private chooseChannel(input: Float32Array[]): number {
    if (input.length === 1) return 0;
    let bestIndex = 0;
    let bestEnergy = -1;
    let selectedEnergy = 0;
    for (let c = 0; c < input.length; c += 1) {
      const samples = input[c];
      let energy = 0;
      for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
      if (c === this.selectedChannel) selectedEnergy = energy;
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestIndex = c;
      }
    }
    if (
      this.selectedChannel >= input.length ||
      selectedEnergy < bestEnergy * CHANNEL_SWITCH_ENERGY_RATIO
    ) {
      this.selectedChannel = bestIndex;
    }
    return this.selectedChannel;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      // Nothing connected yet (or a temporarily silent/disconnected
      // input) -- keep the processor alive rather than exiting; there is
      // nothing to analyze this render quantum.
      return true;
    }
    const channelIndex = this.chooseChannel(input);
    const channel = input[channelIndex];

    for (const frame of this.hopBuffer.push(channel)) {
      // Date.now(), NOT performance.now(): `performance` does not exist in
      // AudioWorkletGlobalScope (worklets deliberately omit it) -- using it
      // here threw "ReferenceError: performance is not defined" the very
      // first time real audio reached this processor, which no prior
      // Node-based test could reveal. Date.now() is a plain ECMAScript
      // built-in, always available. Cost: 1ms resolution, so a single
      // frame's compute time reads as 0 or 1ms; the debug panel's mean over
      // many frames remains a fair estimate.
      const startMs = Date.now();
      const result = this.pipeline.analyzeFrame(frame);
      const computeTimeMs = Date.now() - startMs;

      const message: WorkletAnalysisMessage = {
        type: 'analysis',
        contextTimeS: currentTime,
        workletTimestampMs: Date.now(),
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
        inputChannels: input.length,
        selectedChannel: channelIndex,
      };
      this.port.postMessage(message);
    }

    return true; // keep processing for the AudioContext's lifetime
  }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
