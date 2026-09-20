/**
 * Phase 5 Finger Tuner UI (unchanged since that phase) + Phase 6 Playing
 * Practice UI (now including Phase 7's real Drilling UI, layered on top of
 * the same integration point -- see ./playing-practice-ui.ts), both fed by
 * the same Phase 3 capture -> DSP pipeline. Finger Tuner goes through
 * packages/core's `analyzeTunerReading` + `TunerDisplaySmoother` (see
 * packages/core/src/tuner/tuner-display-smoother.ts); Playing
 * Practice/Drilling goes through `PracticeAttemptTracker` +
 * `PracticeSessionController` instead -- a discrete single-note
 * dwell-and-give-up decision, not a continuous display, so it deliberately
 * does NOT reuse `TunerDisplaySmoother`.
 *
 * This file only consumes the pipeline's output -- it does not touch
 * capture-pipeline.ts, device-enumeration.ts, or anything under
 * @violin/dsp-ts. This phase's own changes here are limited to element
 * bindings (the new `#pp-skip-drill-btn`) -- all of Phase 7's actual logic
 * lives in ./playing-practice-ui.ts. See apps/desktop/CLAUDE.md for the
 * full pipeline writeup, and its "Playing Practice UI (Phase 6)" / "Drilling
 * UI (Phase 7)" sections for what's new in each phase.
 */

import './index.css';
import {
  analyzeTunerReading,
  DEFAULT_IN_TUNE_CENTS_TOLERANCE,
  TunerDisplaySmoother,
  type FingerTunerReading,
  type PitchReading,
  type SmoothedTunerReading,
  type ViolinStringName,
} from '@violin/core';
import {
  requestMicPermissionAndListInputDevices,
  type AudioInputDevice,
} from './audio/device-enumeration.js';
import { AudioCaptureController, type CaptureState } from './audio/capture-pipeline.js';
import type { WorkletAnalysisMessage } from './audio/worklet-messages.js';
import { PlayingPracticeUi } from './playing-practice-ui.js';

console.log(
  '[violin-practice/desktop] renderer booted (Phase 8: eager permission + audio warm-up)',
);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`renderer.ts: expected #${id} to exist in index.html`);
  return el as T;
}

// --- Element bindings ----------------------------------------------------

const appTitle = byId<HTMLElement>('app-title');
const debugToggleBtn = byId<HTMLButtonElement>('debug-toggle-btn');
const debugPanel = byId<HTMLElement>('debug-panel');

const modeTabTuner = byId<HTMLButtonElement>('mode-tab-tuner');
const modeTabPractice = byId<HTMLButtonElement>('mode-tab-practice');

const requestDevicesBtn = byId<HTMLButtonElement>('request-devices-btn');
const deviceStatus = byId<HTMLDivElement>('device-status');
const deviceSelect = byId<HTMLSelectElement>('device-select');
const startBtn = byId<HTMLButtonElement>('start-btn');
const stopBtn = byId<HTMLButtonElement>('stop-btn');
const selfTestBtn = byId<HTMLButtonElement>('self-test-btn');
const captureStatus = byId<HTMLDivElement>('capture-status');

const tunerRoot = byId<HTMLElement>('tuner');
const tunerStateLabel = byId<HTMLElement>('tuner-state-label');
const tunerNote = byId<HTMLElement>('tuner-note');
const tunerCents = byId<HTMLElement>('tuner-cents');
const tunerMeterTrack = byId<HTMLDivElement>('tuner-meter-track');
const tunerMeterNeedle = byId<HTMLDivElement>('tuner-meter-needle');
const tunerFrequency = byId<HTMLElement>('tuner-frequency');
const tunerClipWarning = byId<HTMLElement>('tuner-clip-warning');

const playingPracticeSection = byId<HTMLElement>('playing-practice');

const playingPracticeUi = new PlayingPracticeUi({
  configDetails: byId<HTMLDetailsElement>('pp-config'),
  stringCheckboxes: {
    G: byId<HTMLInputElement>('pp-string-G'),
    D: byId<HTMLInputElement>('pp-string-D'),
    A: byId<HTMLInputElement>('pp-string-A'),
    E: byId<HTMLInputElement>('pp-string-E'),
  } satisfies Record<ViolinStringName, HTMLInputElement>,
  patternSelect: byId<HTMLSelectElement>('pp-pattern'),
  directionSelect: byId<HTMLSelectElement>('pp-direction'),
  minFreqInput: byId<HTMLInputElement>('pp-min-freq'),
  maxFreqInput: byId<HTMLInputElement>('pp-max-freq'),
  preview: byId<HTMLElement>('pp-preview'),
  configError: byId<HTMLElement>('pp-config-error'),
  startBtn: byId<HTMLButtonElement>('pp-start-btn'),
  session: byId<HTMLElement>('pp-session'),
  progress: byId<HTMLElement>('pp-progress'),
  targetRoot: byId<HTMLElement>('pp-target'),
  modeLabel: byId<HTMLElement>('pp-mode-label'),
  targetNote: byId<HTMLElement>('pp-target-note'),
  liveFeedback: byId<HTMLElement>('pp-live-feedback'),
  dwellFill: byId<HTMLElement>('pp-dwell-fill'),
  successBanner: byId<HTMLElement>('pp-success-banner'),
  giveUpBtn: byId<HTMLButtonElement>('pp-giveup-btn'),
  skipDrillBtn: byId<HTMLButtonElement>('pp-skip-drill-btn'),
  complete: byId<HTMLElement>('pp-complete'),
  restartBtn: byId<HTMLButtonElement>('pp-restart-btn'),
});

const debugRaw = byId<HTMLElement>('debug-raw');
const debugSmoothed = byId<HTMLElement>('debug-smoothed');
const debugLevel = byId<HTMLElement>('debug-level');
const debugTrack = byId<HTMLElement>('debug-track');
const debugOnsetState = byId<HTMLElement>('debug-onset-state');
const debugClipping = byId<HTMLElement>('debug-clipping');

function fmtDbfs(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}` : '-∞';
}
let lastDiagLogMs = 0;

const latencyCompute = byId<HTMLElement>('latency-compute');
const latencyRelay = byId<HTMLElement>('latency-relay');
const latencyCadence = byId<HTMLElement>('latency-cadence');
const latencyContext = byId<HTMLElement>('latency-context');
const latencyCount = byId<HTMLElement>('latency-count');

// The meter spans -50c..+50c across its full width, so 1 cent == 1% --
// see index.css's ".tuner-meter-track" comment. Deriving the in-tune
// zone's half-width from packages/core's actual default (rather than
// hardcoding a matching CSS percentage) keeps the drawn zone honest if
// that default is ever tuned.
tunerMeterTrack.style.setProperty(
  '--in-tune-zone-half-width',
  `${DEFAULT_IN_TUNE_CENTS_TOLERANCE}%`,
);
// Halfway between the in-tune tolerance and the meter's outer edge --
// purely a presentation threshold for the meter's 3-color gradient
// (in-tune / close / out), not a scoring decision; does not affect
// anything packages/core computes.
const CLOSE_OUT_BOUNDARY_CENTS =
  DEFAULT_IN_TUNE_CENTS_TOLERANCE + (50 - DEFAULT_IN_TUNE_CENTS_TOLERANCE) / 2;

// --- Rolling latency stats (debug panel) ---------------------------------

const STATS_WINDOW = 200; // ~2.3s of hops at the validated 11.6ms cadence
class RollingStats {
  private readonly values: number[] = [];
  push(v: number | undefined): void {
    if (v === undefined || !Number.isFinite(v)) return;
    this.values.push(v);
    if (this.values.length > STATS_WINDOW) this.values.shift();
  }
  get last(): number | undefined {
    return this.values.at(-1);
  }
  get mean(): number | undefined {
    if (this.values.length === 0) return undefined;
    return this.values.reduce((a, b) => a + b, 0) / this.values.length;
  }
  get stddev(): number | undefined {
    const m = this.mean;
    if (m === undefined) return undefined;
    const variance = this.values.reduce((sum, v) => sum + (v - m) ** 2, 0) / this.values.length;
    return Math.sqrt(variance);
  }
  get p99(): number | undefined {
    if (this.values.length === 0) return undefined;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }
}

const computeTimeStats = new RollingStats();
const relayLatencyStats = new RollingStats();
const hopIntervalStats = new RollingStats();
let framesAnalyzed = 0;

function fmtMs(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(2)}ms`;
}

// --- Tuner display ---------------------------------------------------------

// The vibrato-aware smoothing layer this whole phase is about -- see
// packages/core/src/tuner/tuner-display-smoother.ts. One instance for the
// app's lifetime, explicitly reset whenever a capture session (re)starts
// or stops so one session's tail never bleeds into the next (see that
// class's own doc comment on why timestamps alone don't always guarantee
// this, and resetTunerDisplay() below).
const smoother = new TunerDisplaySmoother();

type TunerTone = 'no-signal' | 'unclear' | 'in-tune' | 'close' | 'out';

function toneFor(reading: SmoothedTunerReading): TunerTone {
  if (reading.status === 'no-signal') return 'no-signal';
  if (reading.status === 'unclear') return 'unclear';
  if (reading.inTune) return 'in-tune';
  return Math.abs(reading.cents) <= CLOSE_OUT_BOUNDARY_CENTS ? 'close' : 'out';
}

/** Mirrors packages/core's note.ts `describeFrequency` sign-formatting exactly (handles -0 correctly) -- see that function's own implementation. */
function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/** FingerTunerReading and SmoothedTunerReading are deliberately the same shape (see tuner-display-smoother.ts's doc comment) -- one formatter covers both for the debug panel's raw-vs-smoothed comparison. */
function formatForDebug(reading: FingerTunerReading | SmoothedTunerReading): string {
  switch (reading.status) {
    case 'no-signal':
      return 'no signal';
    case 'unclear':
      return 'unclear';
    case 'reading':
      return `${reading.note.label} ${formatCents(reading.cents)} (${reading.frequencyHz.toFixed(2)}Hz)${
        reading.inTune ? ' [in tune]' : ''
      }`;
  }
}

/**
 * Renders one smoothed reading to the primary tuner view. Never shows a
 * note name for 'no-signal'/'unclear' -- the note/cents spans are only
 * ever populated in the 'reading' branch below.
 */
function renderTuner(reading: SmoothedTunerReading): void {
  const tone = toneFor(reading);
  tunerRoot.dataset.tone = tone;

  if (reading.status === 'no-signal') {
    tunerStateLabel.hidden = false;
    tunerStateLabel.textContent = 'No signal';
    tunerNote.textContent = '—';
    tunerCents.textContent = '';
    tunerFrequency.hidden = true;
    tunerMeterNeedle.style.left = '50%';
    return;
  }

  if (reading.status === 'unclear') {
    tunerStateLabel.hidden = false;
    tunerStateLabel.textContent = 'Unclear signal (bow noise, double-stop, or background noise?)';
    tunerNote.textContent = '—';
    tunerCents.textContent = '';
    tunerFrequency.hidden = true;
    tunerMeterNeedle.style.left = '50%';
    return;
  }

  tunerStateLabel.hidden = true;
  tunerStateLabel.textContent = '';
  tunerNote.textContent = reading.note.label;
  tunerCents.textContent = formatCents(reading.cents);
  tunerFrequency.hidden = false;
  tunerFrequency.textContent = `${reading.frequencyHz.toFixed(2)}Hz`;

  const clampedCents = Math.max(-50, Math.min(50, reading.cents));
  tunerMeterNeedle.style.left = `${50 + clampedCents}%`;
}

/** Full reset: clears the smoother's history and repaints the "nothing playing yet" state -- used whenever a capture session isn't actively running. */
function resetTunerDisplay(): void {
  smoother.reset();
  renderTuner({ status: 'no-signal' });
  tunerClipWarning.hidden = true;
  debugRaw.textContent = '—';
  debugSmoothed.textContent = '—';
  debugOnsetState.textContent = '—';
  debugClipping.textContent = 'no';
}

resetTunerDisplay();

// --- Debug panel toggle ---------------------------------------------------

debugToggleBtn.addEventListener('click', () => {
  const nowHidden = !debugPanel.hidden;
  debugPanel.hidden = nowHidden;
  debugToggleBtn.setAttribute('aria-expanded', String(!nowHidden));
  debugToggleBtn.textContent = nowHidden ? 'Debug info' : 'Hide debug info';
});

// --- Mode switcher (Phase 6) -----------------------------------------------
//
// Both modes read from the same single AudioCaptureController/analysis
// stream below (one mic session, either view of its live output) -- see
// handleAnalysis(). Switching tabs only changes which section is visible;
// it does not start/stop capture or reset either mode's internal state, so
// switching back to a tab picks up exactly where it left off (Playing
// Practice keeps its place in the sequence; the Finger Tuner's smoothing
// window keeps running in the background the whole time regardless of
// which tab is showing, unchanged from how it already behaved pre-Phase-6).

type AppMode = 'tuner' | 'practice';

function setMode(mode: AppMode): void {
  const tunerActive = mode === 'tuner';
  tunerRoot.hidden = !tunerActive;
  playingPracticeSection.hidden = tunerActive;
  modeTabTuner.setAttribute('aria-pressed', String(tunerActive));
  modeTabPractice.setAttribute('aria-pressed', String(!tunerActive));
  appTitle.textContent = tunerActive ? 'Finger Tuner' : 'Playing Practice';
}

modeTabTuner.addEventListener('click', () => setMode('tuner'));
modeTabPractice.addEventListener('click', () => setMode('practice'));

// --- Device enumeration --------------------------------------------------

let devices: readonly AudioInputDevice[] = [];

async function loadInputDevices(statusCopy: string): Promise<void> {
  requestDevicesBtn.disabled = true;
  deviceStatus.textContent = statusCopy;
  const result = await requestMicPermissionAndListInputDevices();
  requestDevicesBtn.disabled = false;

  if (!result.ok) {
    deviceStatus.textContent = `${result.error}: ${result.message}`;
    deviceSelect.disabled = true;
    startBtn.disabled = true;
    return;
  }

  devices = result.devices;
  deviceStatus.textContent = `${devices.length} input device(s) found.`;
  deviceSelect.innerHTML = '';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label;
    deviceSelect.appendChild(option);
  }
  deviceSelect.disabled = false;
  startBtn.disabled = false;
}

requestDevicesBtn.addEventListener('click', () => {
  void loadInputDevices('Refreshing microphone permission and input devices…');
});

// --- Capture control -------------------------------------------------------

const capture = new AudioCaptureController({
  onState: (state) => renderCaptureState(state),
  onAnalysis: (message, meta) => handleAnalysis(message, meta),
});

void (async () => {
  const bootDeviceStatus = 'Requesting microphone permission and listing input devices…';
  deviceStatus.textContent = bootDeviceStatus;
  captureStatus.textContent = 'warming audio engine…';
  try {
    await Promise.all([capture.prepare(), loadInputDevices(bootDeviceStatus)]);
    captureStatus.textContent = 'idle';
  } catch (err) {
    captureStatus.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
})();

function renderCaptureState(state: CaptureState): void {
  switch (state.status) {
    case 'idle':
      captureStatus.textContent = 'idle';
      resetTunerDisplay();
      break;
    case 'starting':
      captureStatus.textContent = 'starting…';
      startBtn.disabled = true;
      selfTestBtn.disabled = true;
      resetTunerDisplay();
      break;
    case 'running':
      captureStatus.textContent = `running (device: ${state.deviceLabel})`;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      selfTestBtn.disabled = true;
      break;
    case 'self-test':
      captureStatus.textContent = 'running (self-test: synthetic 440Hz tone, no mic)';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      selfTestBtn.disabled = true;
      break;
    case 'stopped':
      captureStatus.textContent = 'stopped';
      startBtn.disabled = devices.length === 0;
      stopBtn.disabled = true;
      selfTestBtn.disabled = false;
      resetTunerDisplay();
      break;
    case 'error':
      captureStatus.textContent = `error: ${state.message}`;
      startBtn.disabled = devices.length === 0;
      stopBtn.disabled = true;
      selfTestBtn.disabled = false;
      resetTunerDisplay();
      break;
  }
}

function handleAnalysis(
  message: WorkletAnalysisMessage,
  meta: { relayLatencyMs?: number; hopArrivalIntervalMs?: number },
): void {
  framesAnalyzed += 1;
  computeTimeStats.push(message.computeTimeMs);
  relayLatencyStats.push(meta.relayLatencyMs);
  hopIntervalStats.push(meta.hopArrivalIntervalMs);

  // Same wiring as before (see apps/desktop/CLAUDE.md's "Pitch reading:
  // continuous, not onset-gated" section): `voiced` is fed continuously
  // and undebounced into packages/core, Finger-Tuner-style. New this
  // phase: the raw per-hop FingerTunerReading is then run through
  // TunerDisplaySmoother before it reaches the primary display -- see the
  // module doc comment at the top of this file.
  const reading: PitchReading = {
    voiced: message.voiced,
    frequencyHz: message.frequencyHz,
    confidence: message.confidence,
  };
  const rawReading = analyzeTunerReading(reading);
  const smoothedReading = smoother.update(rawReading, message.workletTimestampMs);

  renderTuner(smoothedReading);
  tunerClipWarning.hidden = !message.clipping;

  // Phase 6, purely additive: the same raw reading/rawReading this hop
  // already computed above is also fed to Playing Practice's own scoring
  // path (PracticeAttemptTracker, NOT the TunerDisplaySmoother above -- see
  // playing-practice-ui.ts's module doc comment for why). A no-op whenever
  // no Playing Practice sequence has been started yet, and independent of
  // which mode tab is currently visible (see setMode()'s comment).
  playingPracticeUi.handleAnalysisFrame(reading, rawReading, message.workletTimestampMs);

  debugRaw.textContent = formatForDebug(rawReading);
  debugSmoothed.textContent = formatForDebug(smoothedReading);
  debugLevel.textContent = `${fmtDbfs(message.rmsDbfs)} / ${fmtDbfs(message.peakDbfs)}`;
  const track = capture.diagnostics.inputTrack;
  // Throttled console diagnostics -- readable from the Electron process's
  // stdout when launched with ELECTRON_ENABLE_LOGGING=1, so the numbers can
  // be inspected without screen access. Temporary troubleshooting aid.
  const nowMs = performance.now();
  if (!debugPanel.hidden && nowMs - lastDiagLogMs > 1000) {
    lastDiagLogMs = nowMs;
    console.log(
      `[diag] frames=${framesAnalyzed} rms=${fmtDbfs(message.rmsDbfs)} peak=${fmtDbfs(message.peakDbfs)} voiced=${message.voiced} f=${message.frequencyHz.toFixed(1)} conf=${message.confidence.toFixed(2)} onset=${message.onsetState} inCh=${message.inputChannels} selCh=${message.selectedChannel} track=${JSON.stringify(track ?? null)} ctxRate=${capture.diagnostics.sampleRateHz}`,
    );
  }
  debugTrack.textContent = track
    ? `${track.channelCount ?? '?'}ch track, worklet sees ${message.inputChannels}ch, analyzing ch ${message.selectedChannel + 1} / ${track.sampleRate ?? '?'}Hz / ${(track.deviceId ?? '').slice(0, 12)}`
    : `— (no live input track; worklet sees ${message.inputChannels}ch, analyzing ch ${message.selectedChannel + 1})`;
  debugOnsetState.textContent = message.onsetState;
  debugClipping.textContent = message.clipping ? 'YES — reduce input gain' : 'no';

  latencyCompute.textContent = `${fmtMs(computeTimeStats.last)} / ${fmtMs(computeTimeStats.mean)} / ${fmtMs(computeTimeStats.p99)}`;
  latencyRelay.textContent = `${fmtMs(relayLatencyStats.last)} / ${fmtMs(relayLatencyStats.mean)} / ${fmtMs(relayLatencyStats.p99)}`;
  latencyCadence.textContent = `${fmtMs(hopIntervalStats.mean)} / ${fmtMs(hopIntervalStats.stddev)}`;
  latencyCount.textContent = String(framesAnalyzed);

  const { baseLatencyS, sampleRateHz } = capture.diagnostics;
  latencyContext.textContent = `${baseLatencyS !== undefined ? `${(baseLatencyS * 1000).toFixed(2)}ms` : '—'} / ${
    sampleRateHz ?? '—'
  }Hz`;
}

startBtn.addEventListener('click', () => {
  const deviceId = deviceSelect.value;
  if (!deviceId) return;
  framesAnalyzed = 0;
  console.log(
    `[diag] start requested deviceId=${deviceId} label=${deviceSelect.selectedOptions[0]?.textContent ?? '?'}`,
  );
  void capture.start(deviceId);
});

stopBtn.addEventListener('click', () => {
  capture.stop();
});

selfTestBtn.addEventListener('click', () => {
  framesAnalyzed = 0;
  void capture.startSelfTest(440);
});
