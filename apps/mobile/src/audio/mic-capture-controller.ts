/**
 * Owns one AudioRecorder + PitchAnalysisPipeline + HopBuffer instance for
 * one capture session -- the mobile analogue of
 * apps/desktop/src/audio/capture-pipeline.ts's `AudioCaptureController`,
 * feeding the exact same shared `packages/dsp-ts` pipeline apps/desktop
 * uses (see that package's CLAUDE.md), but from react-native-audio-api's
 * event-based `onAudioReady` callback (a JS-thread callback fed by the
 * native recorder) rather than from inside a real `AudioWorkletProcessor`
 * running on the audio-rendering thread itself.
 *
 * That is a deliberate, documented Phase 4 decision, not a default -- see
 * apps/mobile/CLAUDE.md's "DSP hosting: event callback, not a worklet"
 * section for the full reasoning (in short: react-native-audio-api's
 * WorkletProcessingNode/WorkletSourceNode path requires the separate
 * `react-native-worklets` peer dependency and runs the worklet callback on
 * a real audio-priority thread via that library's closure-serialization
 * model; whether a stateful, multi-class object graph like
 * `PitchAnalysisPipeline` [it owns a `YinDetector` + `OnsetSegmenter` +
 * `ClipDetector`, each with mutable per-frame state] can be safely
 * constructed once and reused across many worklet invocations under that
 * serialization model is not something this phase could verify without a
 * real device/simulator, which is explicitly out of scope here -- see the
 * plan's Phase 4 scope and this repo's Hard Rule about not guessing
 * architecturally-significant things). The event-callback path used here
 * is the documented fallback the plan itself names for exactly this case
 * ("otherwise via its standard event-based buffer delivery"), and reuses
 * `HopBuffer` completely unchanged -- it was already written to accept
 * *any* input block size, not just Web Audio's fixed 128-sample render
 * quantum, specifically so this kind of reuse would be mechanical.
 *
 * **Phase 8 update**: this controller now also owns the app's real
 * audio-session interruption handling at the capture layer. It eagerly
 * registers `AudioManager.observeAudioInterruptions(true)` listeners at
 * app boot, pauses the recorder on interruption-began/backgrounding,
 * resumes automatically only when the system explicitly allows it *and*
 * the app is still foregrounded, and treats `routeChange`'s
 * `OldDeviceUnavailable` / `NoSuitableRouteForCategory` as explicit
 * disconnect errors rather than relying solely on the recorder's generic
 * `onError` safety net.
 */
import { AudioManager, AudioRecorder, type AudioEventSubscription } from 'react-native-audio-api';
import {
  forViolin,
  HopBuffer,
  PitchAnalysisPipeline,
  ANALYSIS_FRAME_SIZE,
  ANALYSIS_HOP_SIZE,
  type AnalysisFrameResult,
} from '@violin/dsp-ts';
import {
  backgroundPauseDescriptor,
  describeRouteChangeDisconnect,
  interruptionBeganPauseDescriptor,
  interruptionEndedManualPauseDescriptor,
  shouldAutoResumeAfterInterruptionEnded,
  shouldTreatRouteChangeAsDisconnect,
  type CapturePauseResumeMode,
  type MobileRouteChangeReason,
} from './capture-interruption-policy';

interface MobileInterruptionEvent {
  readonly type: 'began' | 'ended';
  readonly shouldResume: boolean;
}

interface MobileRouteChangeEvent {
  readonly reason: MobileRouteChangeReason;
}

/**
 * Matches apps/desktop's validated configuration exactly (see
 * packages/dsp-ts/CLAUDE.md's "Numbers" section) rather than
 * `AudioManager.getDevicePreferredSampleRate()`, so this phase's readings
 * stay directly comparable to Phase 1/3's own numbers. `forViolin()` is
 * correctly parameterized by whatever rate is passed in (tauMin/tauMax
 * scale with it), so this isn't required for *correctness* -- but using
 * the device's native rate instead could avoid a resampling step the OS
 * might otherwise perform to honor this explicit request, which is a
 * genuine, currently-unverified consideration (no real device available
 * in this phase -- see CLAUDE.md). Revisit once real-device numbers exist.
 */
const CAPTURE_SAMPLE_RATE_HZ = 44100;

/**
 * How many samples react-native-audio-api's `onAudioReady` delivers per
 * JS-thread callback. Chosen as exactly `ANALYSIS_FRAME_SIZE` (2048,
 * ~46ms @ 44.1kHz) as a documented middle ground, not a measured optimum:
 * the library's own doc example uses `sampleRate * 0.1` (~100ms, ~4410
 * samples), which would only deliver new readings ~10x/second; 2048
 * keeps native/JS-thread bridge crossings noticeably less frequent than
 * desktop's own 128-sample (~2.9ms) AudioWorklet render-quantum cadence,
 * while still being ~4x finer-grained than the doc's own example. Each
 * callback typically yields `ANALYSIS_FRAME_SIZE / ANALYSIS_HOP_SIZE` = 4
 * hops' worth of `HopBuffer` output at once (processed in a tight loop --
 * each hop's analysis is sub-millisecond per Phase 1/3's own numbers, so
 * this doesn't add real compute latency, just delivery-granularity
 * latency). No real device was available in this phase to benchmark
 * whether a smaller value would meaningfully improve smoothness without
 * excessive bridge overhead -- flagged in CLAUDE.md as a concrete,
 * cheap-to-try tuning knob for the orchestrator's/user's simulator pass.
 */
const CAPTURE_BUFFER_LENGTH = ANALYSIS_FRAME_SIZE;

export type CaptureState =
  | { readonly status: 'idle' }
  | { readonly status: 'starting' }
  | { readonly status: 'running' }
  | {
      readonly status: 'paused';
      readonly message: string;
      readonly resumeMode: CapturePauseResumeMode;
    }
  | { readonly status: 'stopped' }
  | { readonly status: 'error'; readonly message: string };

/**
 * `AnalysisFrameResult` plus a compute-time measurement taken around this
 * hop's `PitchAnalysisPipeline.analyzeFrame` call -- the mobile analogue
 * of `WorkletAnalysisMessage.computeTimeMs` on desktop (see
 * apps/desktop/src/audio/worklet-messages.ts), the one latency number
 * that's genuinely comparable across both platforms (pure DSP compute
 * cost, no cross-thread relay assumption). Desktop's fuller 3-metric
 * latency panel (compute / cross-thread relay / hop-arrival cadence) isn't
 * mirrored here: there is no separate audio-thread-vs-main-thread split in
 * this event-callback design (see this file's top comment) for a "relay
 * latency" to even mean the same thing, and this phase has no real device
 * to measure hop-arrival jitter against. This one number is still directly
 * useful once the orchestrator/user runs this on a real device: does
 * mobile's compute cost also comfortably fit inside the ~11.6ms hop budget
 * Phase 1/3 validated on C++/desktop-TS respectively?
 */
export interface MobileAnalysisResult extends AnalysisFrameResult {
  readonly computeTimeMs: number;
}

export interface MicCaptureEvents {
  onState?: (state: CaptureState) => void;
  onAnalysis?: (result: MobileAnalysisResult) => void;
}

export class MicCaptureController {
  private currentState: CaptureState = { status: 'idle' };
  private recorder: AudioRecorder | undefined;
  private hopBuffer: HopBuffer | undefined;
  private pipeline: PitchAnalysisPipeline | undefined;
  private sessionActive = false;
  private appIsActive = true;
  private interruptionActive = false;
  private prepared = false;
  private resumablePause = false;
  private backgroundPausePending = false;
  private interruptionSubscription: AudioEventSubscription | undefined;
  private routeChangeSubscription: AudioEventSubscription | undefined;
  private sessionToken = 0;

  constructor(private readonly events: MicCaptureEvents = {}) {}

  private setState(state: CaptureState): void {
    this.currentState = state;
    this.events.onState?.(state);
  }

  /**
   * Configures the iOS audio session for recording-only use, with
   * `iosMode: 'measurement'` specifically because Apple documents that
   * mode as minimizing the system's own signal processing (AGC etc.) --
   * the closest native equivalent to desktop's explicit
   * echoCancellation/noiseSuppression/autoGainControl: false
   * `getUserMedia` constraints (see apps/desktop/src/audio/
   * capture-pipeline.ts). Safe to call before permission is granted or
   * capture starts -- it only configures options, it doesn't activate the
   * session or request anything.
   *
   * NOTE (flagged, not silently assumed -- see CLAUDE.md's "Known
   * correctness gap: Android AGC" section): no equivalent Android-side
   * "disable AGC / noise suppression" control (e.g. an `audioSource`
   * override like `UNPROCESSED`/`VOICE_RECOGNITION`) was found anywhere
   * in react-native-audio-api 0.13.3's documented `AudioManager`/
   * `AudioRecorder` surface during this phase's research. This is a real,
   * currently-unresolved gap against this app's #1 priority
   * (pitch-detection correctness) specifically on Android, not an
   * oversight in this file -- Android devices often apply aggressive
   * platform AGC/NS by default with no exposed way to disable it through
   * this library today.
   */
  static configureSession(): void {
    AudioManager.setAudioSessionOptions({
      iosCategory: 'record',
      iosMode: 'measurement',
      iosOptions: [],
    });
  }

  get isActive(): boolean {
    return this.sessionActive;
  }

  prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    AudioManager.observeAudioInterruptions(true);
    this.interruptionSubscription = AudioManager.addSystemEventListener('interruption', (event) => {
      void this.handleInterruptionEvent(event);
    });
    this.routeChangeSubscription = AudioManager.addSystemEventListener('routeChange', (event) => {
      void this.handleRouteChangeEvent(event);
    });
    this.ensureSessionObjects();
  }

  setAppActive(active: boolean): void {
    this.appIsActive = active;
  }

  async pauseForBackground(): Promise<void> {
    this.appIsActive = false;
    this.backgroundPausePending = true;
    if (this.currentState.status === 'paused' && this.resumablePause) {
      this.setState({ status: 'paused', ...backgroundPauseDescriptor() });
      return;
    }
    if (!this.sessionActive || !this.recorder) return;
    await this.pauseSession(backgroundPauseDescriptor());
  }

  /**
   * Starts capture from whatever input the OS currently has active (see
   * apps/mobile/CLAUDE.md's "External audio interface" section for what
   * this library does and doesn't let the app control about *which*
   * input that is). Caller is responsible for having already obtained
   * 'Granted' permission (see permissions.ts) -- this method does not
   * request permission itself, mirroring the separation already
   * established on desktop (device-enumeration.ts's permission flow is
   * separate from capture-pipeline.ts's pure capture logic).
   */
  async start(): Promise<void> {
    if (this.sessionActive || this.currentState.status === 'starting') return;
    this.setState({ status: 'starting' });
    try {
      if (this.resumablePause && this.recorder) {
        await AudioManager.setAudioSessionActivity(true);
        this.recorder.resume();
        this.sessionActive = true;
        this.resumablePause = false;
        this.backgroundPausePending = false;
        this.interruptionActive = false;
        this.setState({ status: 'running' });
        return;
      }

      this.ensureSessionObjects();
      await AudioManager.setAudioSessionActivity(true);
      const result = await this.recorder!.start();
      if (result.status === 'error') {
        throw new Error(result.message);
      }

      this.sessionActive = true;
      this.resumablePause = false;
      this.backgroundPausePending = false;
      this.interruptionActive = false;
      this.setState({ status: 'running' });
    } catch (err) {
      this.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      await this.cleanupSession();
    }
  }

  async stop(): Promise<void> {
    if (!this.sessionActive && !this.recorder && !this.resumablePause) {
      this.setState({ status: 'stopped' });
      return;
    }
    await this.cleanupSession();
    this.setState({ status: 'stopped' });
  }

  async dispose(): Promise<void> {
    await this.cleanupSession();
    this.interruptionSubscription?.remove();
    this.interruptionSubscription = undefined;
    this.routeChangeSubscription?.remove();
    this.routeChangeSubscription = undefined;
    AudioManager.observeAudioInterruptions(false);
  }

  private ensureSessionObjects(): void {
    if (this.recorder && this.hopBuffer && this.pipeline) return;

    const recorder = new AudioRecorder();
    const hopBuffer = new HopBuffer(ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE);
    const pipeline = new PitchAnalysisPipeline(forViolin(CAPTURE_SAMPLE_RATE_HZ));
    const sessionToken = ++this.sessionToken;

    recorder.onAudioReady(
      {
        sampleRate: CAPTURE_SAMPLE_RATE_HZ,
        bufferLength: CAPTURE_BUFFER_LENGTH,
        channelCount: 1,
      },
      ({ buffer }) => {
        if (sessionToken !== this.sessionToken || !this.sessionActive) return;

        // Mono: violin pitch detection is monophonic by design (see root
        // CLAUDE.md) -- channel 0 is all we need even if the device ends up
        // delivering more than requested (the docs note actual values "may
        // vary depending on device capabilities").
        const channel = buffer.getChannelData(0);
        for (const frame of hopBuffer.push(channel)) {
          const startMs = performance.now();
          const analysis = pipeline.analyzeFrame(frame);
          const computeTimeMs = performance.now() - startMs;
          this.events.onAnalysis?.({ ...analysis, computeTimeMs });
        }
      },
    );

    // Kept as the last-resort safety net even after Phase 8's more specific
    // interruption/route-change handling: unexpected recorder failures still
    // need to surface a visible state, but expected pause paths should not
    // fight the deliberate paused/error states above.
    recorder.onError((error) => {
      if (sessionToken !== this.sessionToken) return;
      if (
        this.currentState.status === 'paused' &&
        (this.interruptionActive || this.backgroundPausePending)
      ) {
        return;
      }
      if (this.currentState.status === 'error') return;
      this.setState({ status: 'error', message: error.message });
      void this.cleanupSession();
    });

    this.recorder = recorder;
    this.hopBuffer = hopBuffer;
    this.pipeline = pipeline;
  }

  private async pauseSession({
    message,
    resumeMode,
  }: {
    message: string;
    resumeMode: CapturePauseResumeMode;
  }): Promise<void> {
    if (!this.recorder || !this.sessionActive) return;
    this.resumablePause = true;
    this.sessionActive = false;
    try {
      this.recorder.pause();
    } catch {
      // If the native recorder has already transitioned away from recording
      // because of the same OS event, deactivation below is still enough to
      // keep the app out of a bogus "running" UI state.
    }
    try {
      await AudioManager.setAudioSessionActivity(false);
    } catch {
      // Expected after some OS interruptions/background transitions.
    }
    this.setState({ status: 'paused', message, resumeMode });
  }

  private async handleInterruptionEvent(event: MobileInterruptionEvent): Promise<void> {
    if (event.type === 'began') {
      this.interruptionActive = true;
      if (!this.sessionActive || !this.recorder) return;
      await this.pauseSession(interruptionBeganPauseDescriptor());
      return;
    }

    this.interruptionActive = false;
    if (!this.resumablePause || !this.recorder) return;

    if (
      shouldAutoResumeAfterInterruptionEnded({
        shouldResume: event.shouldResume,
        appIsActive: this.appIsActive,
        backgroundPausePending: this.backgroundPausePending,
      })
    ) {
      await this.start();
      return;
    }

    const descriptor = this.backgroundPausePending
      ? backgroundPauseDescriptor()
      : interruptionEndedManualPauseDescriptor();
    this.setState({ status: 'paused', ...descriptor });
  }

  private async handleRouteChangeEvent(event: MobileRouteChangeEvent): Promise<void> {
    if (!shouldTreatRouteChangeAsDisconnect(event.reason)) return;
    if (!this.sessionActive && !this.resumablePause) return;

    this.interruptionActive = false;
    this.backgroundPausePending = false;
    this.setState({ status: 'error', message: describeRouteChangeDisconnect(event.reason) });
    await this.cleanupSession();
  }

  private async cleanupSession(): Promise<void> {
    this.sessionActive = false;
    this.resumablePause = false;
    this.backgroundPausePending = false;
    this.interruptionActive = false;
    this.sessionToken += 1;
    const recorder = this.recorder;
    this.recorder = undefined;
    this.hopBuffer = undefined;
    this.pipeline = undefined;
    try {
      recorder?.clearOnAudioReady();
      recorder?.clearOnError();
      recorder?.disconnect();
      await recorder?.stop();
    } catch {
      // Best-effort teardown -- never let a cleanup failure mask whatever
      // error state the caller already set.
    }
    try {
      await AudioManager.setAudioSessionActivity(false);
    } catch {
      // Ignore -- session may already be inactive (e.g. after an OS-level
      // interruption already deactivated it).
    }
  }
}
