/**
 * Owns the live Web Audio graph for one capture session: AudioContext +
 * (MediaStreamSource for real capture, or an OscillatorNode for the
 * no-mic-needed self-test) -> AudioWorkletNode running PitchProcessor
 * (see pitch-worklet-processor.ts). Main-thread code -- part of the
 * DOM-lib tsconfig project, NOT the worklet itself.
 */

import { PITCH_PROCESSOR_NAME, type WorkletAnalysisMessage } from './worklet-messages.js';
// Vite's documented `?worker&url` query suffix (see vite/client.d.ts's
// `declare module '*?worker&url'`): resolves to a STRING URL pointing at a
// properly bundled chunk for the target module (its own imports resolved,
// TS transpiled to JS), in both dev and production builds.
//
// This -- not the more commonly-suggested `new URL('./x.ts', import.meta.url)`
// + `audioWorklet.addModule(url)` pattern -- is what actually works
// correctly for a packaged build: `new URL(...)` alone makes Vite treat the
// target as a generic static asset and copy the RAW, untranspiled .ts file
// verbatim (confirmed empirically during this phase -- `pnpm package`'s
// output bundle referenced a `pitch-worklet-processor-<hash>.ts` asset
// containing literal TypeScript syntax, which would fail at runtime when
// fetched as a JS module). `?worker&url` uses Vite's worker-specific
// handling instead, which bundles the file for real. See
// apps/desktop/CLAUDE.md for the full writeup.
import workletModuleUrl from './pitch-worklet-processor.ts?worker&url';

export type CaptureState =
  | { readonly status: 'idle' }
  | { readonly status: 'starting' }
  | { readonly status: 'running'; readonly deviceLabel: string }
  | { readonly status: 'self-test' }
  | { readonly status: 'stopped' }
  | { readonly status: 'error'; readonly message: string };

export interface AnalysisMeta {
  /**
   * `performance.now()` delta between the worklet posting this message and
   * the main thread receiving it -- see worklet-messages.ts's doc comment
   * on the shared-time-origin assumption this rests on. `undefined` is
   * never actually produced today but kept in the type in case a future
   * engine/measurement path can't supply it, so callers don't assume it's
   * always present.
   */
  readonly relayLatencyMs: number | undefined;
  /** Wall-clock time since the *previous* message arrived on the main thread -- the actual observed hop cadence, no cross-thread clock assumption at all (should hover near ANALYSIS_HOP_SIZE/sampleRate seconds, e.g. ~11.6ms @ 44.1kHz/512). */
  readonly hopArrivalIntervalMs: number | undefined;
}

export interface CaptureEvents {
  onState?: (state: CaptureState) => void;
  onAnalysis?: (message: WorkletAnalysisMessage, meta: AnalysisMeta) => void;
}

export class AudioCaptureController {
  private audioContext: AudioContext | undefined;
  private mediaStream: MediaStream | undefined;
  private workletNode: AudioWorkletNode | undefined;
  private muteGain: GainNode | undefined;
  private oscillator: OscillatorNode | undefined;
  private moduleLoaded = false;
  private lastMessageAtMs: number | undefined;
  private startToken = 0;

  constructor(private readonly events: CaptureEvents = {}) {}

  private setState(state: CaptureState): void {
    this.events.onState?.(state);
  }

  private async ensureModuleLoaded(audioContext: AudioContext): Promise<void> {
    if (this.moduleLoaded) return;
    await audioContext.audioWorklet.addModule(workletModuleUrl);
    this.moduleLoaded = true;
  }

  private async ensurePreparedContext(): Promise<AudioContext> {
    if (this.audioContext) return this.audioContext;
    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    await this.ensureModuleLoaded(audioContext);
    await audioContext.suspend();
    return audioContext;
  }

  /**
   * Builds the AudioWorkletNode and wires it to a *muted* path to
   * `audioContext.destination`. This isn't cosmetic: a Web Audio node with
   * no path (direct or indirect) to the context's destination is not
   * guaranteed to have its `process()` called at all in Chromium -- the
   * graph is pulled from the destination outward. Muting via a zero-gain
   * node keeps the graph "live" (so PitchProcessor actually runs) without
   * the user hearing their own input, or the self-test oscillator, played
   * back.
   */
  private createWorkletNode(audioContext: AudioContext): AudioWorkletNode {
    const workletNode = new AudioWorkletNode(audioContext, PITCH_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain).connect(audioContext.destination);
    this.muteGain = muteGain;

    workletNode.port.onmessage = (event: MessageEvent<WorkletAnalysisMessage>) => {
      const now = performance.now();
      const relayLatencyMs = now - event.data.workletTimestampMs;
      const hopArrivalIntervalMs =
        this.lastMessageAtMs === undefined ? undefined : now - this.lastMessageAtMs;
      this.lastMessageAtMs = now;
      this.events.onAnalysis?.(event.data, { relayLatencyMs, hopArrivalIntervalMs });
    };

    return workletNode;
  }

  async prepare(): Promise<void> {
    await this.ensurePreparedContext();
  }

  /**
   * Starts real capture from the given input device with the constraints
   * task point 2 requires: echoCancellation/noiseSuppression/
   * autoGainControl explicitly false (they're designed to suppress
   * non-voice, pure-tone-like signal and actively hurt pitch detection if
   * left on -- see apps/desktop/CLAUDE.md).
   */
  async start(deviceId: string): Promise<void> {
    const startToken = ++this.startToken;
    this.setState({ status: 'starting' });
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      if (startToken !== this.startToken) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
        this.mediaStream = undefined;
        return;
      }

      const audioContext = await this.ensurePreparedContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      if (startToken !== this.startToken) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
        this.mediaStream = undefined;
        return;
      }

      const source = audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = this.createWorkletNode(audioContext);
      source.connect(this.workletNode);

      const track = this.mediaStream.getAudioTracks()[0];
      // Device-unplug handling, assessed in Phase 8: for desktop's current
      // app-level bar ("promptly show an unambiguous visible state; do not
      // silently fall back to another mic; do not leave the UI stuck on
      // running"), the existing MediaStreamTrack `ended` signal is
      // sufficient. If a richer reconnect workflow is ever added, it can
      // layer on top of this same transition rather than replacing it.
      track?.addEventListener('ended', () => {
        this.setState({ status: 'error', message: 'Input device disconnected.' });
        void this.cleanupSession();
      });
      this.setState({ status: 'running', deviceLabel: track?.label ?? deviceId });
    } catch (err) {
      this.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      void this.cleanupSession();
    }
  }

  /**
   * Self-test path (task point 6's latency measurement, and a quick
   * pipeline smoke-check that needs no microphone at all): routes a
   * synthetic oscillator tone through the exact same AudioContext ->
   * AudioWorkletNode -> PitchProcessor graph real capture uses. Proves the
   * capture->analysis->message-relay path end-to-end; does NOT prove
   * anything about real microphone/line-in hardware or drivers -- see
   * apps/desktop/CLAUDE.md's verification section for exactly what this
   * does and doesn't cover.
   */
  async startSelfTest(frequencyHz = 440): Promise<void> {
    const startToken = ++this.startToken;
    this.setState({ status: 'starting' });
    try {
      const audioContext = await this.ensurePreparedContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      if (startToken !== this.startToken) return;

      const oscillator = audioContext.createOscillator();
      oscillator.frequency.value = frequencyHz;
      oscillator.type = 'sine';
      this.oscillator = oscillator;

      this.workletNode = this.createWorkletNode(audioContext);
      oscillator.connect(this.workletNode);
      oscillator.start();

      this.setState({ status: 'self-test' });
    } catch (err) {
      this.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      void this.cleanupSession();
    }
  }

  /** Read-only diagnostics for the debug UI (task point 6). `undefined` fields mean "not applicable to the current graph" (e.g. no real input track when running the oscillator self-test). */
  get diagnostics(): { baseLatencyS: number | undefined; sampleRateHz: number | undefined } {
    return {
      baseLatencyS: this.audioContext?.baseLatency,
      sampleRateHz: this.audioContext?.sampleRate,
    };
  }

  private async cleanupSession(): Promise<void> {
    this.startToken += 1;
    try {
      this.oscillator?.stop();
    } catch {
      // Safe best-effort teardown: stop() throws if the oscillator was never
      // started or has already been stopped by the same transition.
    }
    this.oscillator?.disconnect();
    this.oscillator = undefined;
    this.workletNode?.disconnect();
    this.workletNode = undefined;
    this.muteGain?.disconnect();
    this.muteGain = undefined;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = undefined;
    await this.audioContext?.suspend().catch(() => undefined);
    this.lastMessageAtMs = undefined;
  }

  stop(): void {
    void this.cleanupSession();
    this.setState({ status: 'stopped' });
  }
}
