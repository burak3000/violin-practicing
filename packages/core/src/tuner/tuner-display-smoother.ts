/**
 * Vibrato-aware smoothing for the Finger Tuner *display* only.
 *
 * packages/core's `analyzeTunerReading` (see ./finger-tuner.ts) is
 * deliberately stateless/per-reading -- correct for that layer, since a
 * slide/portamento should show continuously rather than being debounced
 * (see that file's doc comment). But feeding its raw, per-hop output
 * straight to a UI creates a *different*, real problem: violin vibrato
 * oscillates the pitch ~5-7Hz with ~10-30 cents of *intentional*, musical
 * modulation. That's faster than a per-frame display can read as "wobbling
 * around one note" -- it instead reads as the tuner itself flickering
 * between in-tune/out-of-tune many times a second, which is a real,
 * user-visible correctness bug for anyone who vibrates, not a cosmetic
 * nit. Hence this separate, stateful layer, deliberately kept out of
 * finger-tuner.ts rather than folded into it: `analyzeTunerReading` stays a
 * pure, dependency-free function; this class is the temporal layer on top,
 * consumed only by UI code that renders a live display.
 *
 * ## Approach
 *
 * Consumes a stream of the *already-gated* `FingerTunerReading`s (not raw
 * `PitchReading`s) plus a timestamp per reading -- reusing
 * `analyzeTunerReading`'s confidence/plausible-range gating rather than
 * re-implementing it here, so this module's only job is temporal
 * smoothing, nothing else. Internally, "pitch" is tracked as a continuous
 * MIDI-number float (`frequencyHzToMidi`), not as
 * cents-relative-to-the-instantaneous-nearest-note -- averaging in that
 * log-frequency space, and *only then* re-deriving the nearest note/cents
 * from the smoothed value (mirroring exactly what `analyzeFrequency` does
 * for a single reading), avoids a subtler bug a naive "average the cents
 * field" approach would have: cents is only meaningful relative to
 * whichever note happens to be nearest *that instant*, so averaging raw
 * cents values across a moment where the nearest-note assignment itself
 * flips (e.g. vibrato straddling a semitone boundary) would silently
 * average together numbers measured against two different references.
 *
 * Two behaviors, driven by one heuristic:
 *
 * 1. **Vibrato / normal jitter** -- averaged with a plain arithmetic mean
 *    ("boxcar" moving average) over a short trailing window (`windowMs`,
 *    default `DEFAULT_TUNER_SMOOTHING_WINDOW_MS`) of recent samples. A
 *    boxcar over a window that's short relative to a vibrato cycle does
 *    NOT fully cancel the oscillation -- it attenuates it by a
 *    `sinc(vibratoHz * windowMs)`-shaped factor, not to zero -- but it's a
 *    large, real reduction: at the default 120ms window, a 5Hz vibrato's
 *    amplitude is cut roughly in half, and a 7Hz vibrato's by roughly
 *    two-thirds (see `DEFAULT_TUNER_SMOOTHING_WINDOW_MS` for the reasoning
 *    behind that specific number). That's the actual payoff this class
 *    exists for: even though the displayed number still wiggles a little,
 *    it wiggles far less, and critically the *in-tune boolean* (`inTune`
 *    below) stops flickering, because the residual swing is small relative
 *    to `DEFAULT_IN_TUNE_CENTS_TOLERANCE`.
 * 2. **A genuine pitch change** (a slide arriving at a new note, or
 *    stopping one note and starting another) -- detected when a new sample
 *    deviates from the *currently-displayed* smoothed value by more than
 *    `transitionThresholdCents` (default
 *    `DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS`: comfortably above the
 *    cited max vibrato depth and comfortably below a semitone). When that
 *    happens, the window is discarded and restarted from just the new
 *    sample, so the display *snaps* to the new pitch immediately rather
 *    than being dragged toward it by now-stale samples from the old note.
 *    A continuous slide only crosses this per-sample threshold if it moves
 *    fast enough to jump more than `transitionThresholdCents` within one
 *    hop -- otherwise each new sample is close enough to the last
 *    displayed value to be treated as a continuation, so the average keeps
 *    sliding forward hop by hop (with the same bounded smoothing lag
 *    described above, not a freeze).
 *
 * `'no-signal'`/`'unclear'` readings are passed through immediately,
 * unsmoothed (never blended toward a stale prior pitch), and also clear
 * the internal window -- so the very first `'reading'` after any dropout
 * starts a fresh window rather than being averaged against pitch from
 * before the dropout. This is also what makes "stop playing one note,
 * start another" (with even a brief silence between them) track
 * immediately: the silence itself resets the window.
 *
 * ## Documented limitations (not fixed here; a reasonable place to revisit
 * if real playing ever demonstrates a problem)
 *
 * - A single spurious frame that both passes the upstream confidence/range
 *   gate *and* lands more than `transitionThresholdCents` away from the
 *   current note (e.g. a brief octave error, or bow noise YIN mis-resolves
 *   as strongly periodic) is read as a "transition" and causes one visible
 *   snap/flicker rather than being filtered as an outlier. Not specifically
 *   guarded against: the upstream confidence gate already screens out most
 *   of this, and requiring multiple confirming samples before accepting a
 *   transition would add latency to *genuine* transitions too, which is a
 *   worse tradeoff for a live display than an occasional single-frame
 *   glitch.
 * - Every single `'unclear'`/`'no-signal'` frame resets the window, even a
 *   single transient one in the middle of an otherwise-steady note (e.g. a
 *   bow-change blip that dips under the confidence gate for one hop). This
 *   is a deliberate simplicity choice, not an oversight: bridging over
 *   transient dropouts would need its own debounce/hysteresis policy --
 *   arguably closer to Playing Practice's dwell tracking (`scoring.ts`'s
 *   `TargetNoteDwellTracker`) than "smooth vibrato" -- and wasn't asked
 *   for here.
 * - The moving average is a plain boxcar, not a proper low-pass filter --
 *   chosen for simplicity and predictability (easy to reason about and
 *   unit-test exactly), not because it's the theoretically optimal
 *   attenuation-vs-lag tradeoff.
 * - Vibrato that straddles a semitone boundary closely enough, or is wide
 *   enough, to occasionally exceed `transitionThresholdCents` away from the
 *   running average would be (mis)read as a transition and cause visible
 *   snapping instead of smoothing. `DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS`
 *   is set well above the cited max vibrato depth specifically to make this
 *   rare, not impossible.
 *
 * Pure TypeScript, no DOM/Node/React-Native imports -- `apps/mobile`'s
 * Phase 5 Part B is expected to reuse this exact class.
 */

import {
  DEFAULT_A4_HZ,
  frequencyHzToMidi,
  midiNumberToNoteName,
  midiToFrequencyHz,
  type NoteName,
} from '../note/note.js';
import { DEFAULT_IN_TUNE_CENTS_TOLERANCE, isWithinTolerance } from '../scoring/scoring.js';
import type { FingerTunerReading } from './finger-tuner.js';

/**
 * Trailing-window size (ms) for the moving average. Biased toward the
 * more-smoothing end of the plan's cited 50-130ms range rather than its
 * midpoint, because the worst case for attenuation is the *slow* end of
 * the cited 5-7Hz vibrato range -- a slower oscillation is harder to
 * average out in a fixed window. At 120ms: a 5Hz vibrato's amplitude
 * carries through at roughly 50% (attenuated by half), a 7Hz vibrato's at
 * roughly 37% -- both a large, real reduction versus the raw signal, per
 * the module doc comment's "Vibrato / normal jitter" section. A longer
 * window would attenuate more at the cost of more display lag. Tunable via
 * `TunerDisplaySmootherConfig.windowMs`, not a locked constant.
 */
export const DEFAULT_TUNER_SMOOTHING_WINDOW_MS = 120;

/**
 * How far (in cents) a new sample must deviate from the currently-displayed
 * smoothed value before it's treated as a genuine pitch change rather than
 * vibrato -- comfortably above the cited max vibrato depth (30 cents) and
 * comfortably below a semitone (100 cents), so an actual move to an
 * adjacent note is still caught immediately. Tunable via
 * `TunerDisplaySmootherConfig.transitionThresholdCents`, not a locked
 * constant.
 */
export const DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS = 50;

export interface TunerDisplaySmootherConfig {
  /**
   * Reference pitch for this class's own internal Hz<->MIDI math. This is
   * independent of whatever `a4Hz` the caller used to produce the incoming
   * `FingerTunerReading`s (this class only reads `frequencyHz` off a
   * `'reading'`-status input, never its `note`/`cents`, and re-derives both
   * itself from the smoothed frequency) -- but should normally be set to
   * match, or the smoothed note/cents will be measured against a different
   * concert pitch than whatever the raw per-frame reading implied. Default
   * 440 (`DEFAULT_A4_HZ`).
   */
  readonly a4Hz?: number;
  /** See `DEFAULT_TUNER_SMOOTHING_WINDOW_MS`. */
  readonly windowMs?: number;
  /** See `DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS`. */
  readonly transitionThresholdCents?: number;
  /** Tolerance band used to compute the smoothed reading's `inTune` flag -- same meaning as `ScoringConfig.inTuneCentsTolerance`. Default `DEFAULT_IN_TUNE_CENTS_TOLERANCE` (25). */
  readonly inTuneCentsTolerance?: number;
}

/**
 * Same shape as `FingerTunerReading` -- see that type's doc comment for
 * what each status means. Sharing the shape is deliberate: a UI can reuse
 * one renderer for both the raw and the smoothed reading (e.g. a "debug:
 * raw vs smoothed" toggle) without a separate rendering path.
 */
export type SmoothedTunerReading =
  | { readonly status: 'no-signal' }
  | { readonly status: 'unclear' }
  | {
      readonly status: 'reading';
      readonly note: NoteName;
      readonly cents: number;
      readonly inTune: boolean;
      readonly frequencyHz: number;
    };

interface Sample {
  readonly timestampMs: number;
  readonly midiFloat: number;
}

/**
 * Stateful -- one instance per live tuner display. See the module doc
 * comment for the full smoothing/transition-detection design.
 *
 * Call `update()` once per incoming `FingerTunerReading`, in non-decreasing
 * `timestampMs` order (the unit/epoch is the caller's choice, as long as
 * it's consistent from call to call -- e.g. `performance.now()` or an
 * AudioContext-relative clock both work). Call `reset()` when a capture
 * session stops/restarts so a new session isn't smoothed against the tail
 * of the previous one.
 */
export class TunerDisplaySmoother {
  private readonly a4Hz: number;
  private readonly windowMs: number;
  private readonly transitionThresholdCents: number;
  private readonly inTuneCentsTolerance: number;

  private samples: Sample[] = [];
  private lastOutputMidi: number | undefined;
  private lastTimestampMs: number | undefined;

  constructor(config: TunerDisplaySmootherConfig = {}) {
    this.a4Hz = config.a4Hz ?? DEFAULT_A4_HZ;
    this.windowMs = config.windowMs ?? DEFAULT_TUNER_SMOOTHING_WINDOW_MS;
    this.transitionThresholdCents =
      config.transitionThresholdCents ?? DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS;
    this.inTuneCentsTolerance = config.inTuneCentsTolerance ?? DEFAULT_IN_TUNE_CENTS_TOLERANCE;
  }

  /** Discards all internal history. Safe to call at any time, including mid-stream. */
  reset(): void {
    this.samples = [];
    this.lastOutputMidi = undefined;
    this.lastTimestampMs = undefined;
  }

  update(reading: FingerTunerReading, timestampMs: number): SmoothedTunerReading {
    if (reading.status !== 'reading') {
      // Never smooth garbage into a fake reading -- pass the drop-out
      // through immediately, and clear the window so the next real
      // reading starts fresh rather than being pulled toward pre-dropout
      // history. See the module doc comment's documented limitations for
      // why *every* dropout resets, not just long ones.
      this.reset();
      return { status: reading.status };
    }

    // Defensive: a timestamp that goes backward relative to the last
    // sample seen (e.g. a stale hop from a torn-down capture session
    // delivered after a new one already started) would otherwise corrupt
    // the window-eviction math below. Treat it like a dropout: discard
    // history and start over from this sample.
    if (this.lastTimestampMs !== undefined && timestampMs < this.lastTimestampMs) {
      this.samples = [];
      this.lastOutputMidi = undefined;
    }
    this.lastTimestampMs = timestampMs;

    const midiFloat = frequencyHzToMidi(reading.frequencyHz, this.a4Hz);

    // MIDI numbers already live on a log2, equal-tempered scale where 1
    // unit == 1 semitone == 100 cents, so this multiplication is an exact
    // cents delta, not an approximation.
    const isTransition =
      this.lastOutputMidi !== undefined &&
      Math.abs(midiFloat - this.lastOutputMidi) * 100 > this.transitionThresholdCents;

    if (isTransition) {
      this.samples = [{ timestampMs, midiFloat }];
    } else {
      this.samples.push({ timestampMs, midiFloat });
      const cutoffMs = timestampMs - this.windowMs;
      this.samples = this.samples.filter((sample) => sample.timestampMs >= cutoffMs);
    }

    const smoothedMidi =
      this.samples.reduce((sum, sample) => sum + sample.midiFloat, 0) / this.samples.length;
    this.lastOutputMidi = smoothedMidi;

    const nearestMidi = Math.round(smoothedMidi);
    const cents = (smoothedMidi - nearestMidi) * 100;
    return {
      status: 'reading',
      note: midiNumberToNoteName(nearestMidi),
      cents,
      inTune: isWithinTolerance(cents, { inTuneCentsTolerance: this.inTuneCentsTolerance }),
      frequencyHz: midiToFrequencyHz(smoothedMidi, this.a4Hz),
    };
  }
}
