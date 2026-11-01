/**
 * PlayAlongSession: the scoring engine of the timed play-along.
 *
 * In the waiting modes (Playing Practice, ABC practice) the app holds still
 * until the player gets a note right. Here the clock cannot stop: a metronome
 * clicks, the piece advances on the beat, and every note must be played in
 * tune AND roughly on time. This class takes the pitch detector's frames
 * (`update(reading, timestampMs)`), measures them against a `PlayAlongPlan`'s
 * timeline, and decides for each note -- as early as it can -- whether it was
 * a hit, or why it was missed. Missed notes are listed afterwards; there is no
 * Drilling in this mode.
 *
 * Pure TypeScript, no platform imports. `update` is a per-frame path (every
 * ~11.6 ms): it never throws (bad timestamps are ignored), allocates only the
 * returned update, and does work only for the few notes whose time window is
 * currently open. Construction and `start` are not per-frame and do validate
 * their arguments (`RangeError`).
 *
 * ## Clocks
 *
 * `zeroMs` is the caller's timestamp at which plan time 0 (the start of the
 * music) occurs -- on the same clock as the `timestampMs` it passes to
 * `update`, which differs per platform (epoch ms on desktop,
 * `performance.now()` on mobile). The count-in starts at
 * `zeroMs - plan.countInMs`. Inside this class everything is in *plan time*
 * (`timestampMs - zeroMs`).
 *
 * ## Lag compensation (`shift`)
 *
 * What the detector reports lags what the player did: the YIN analysis window
 * is ~46 ms long, so a note is only recognised once the window is mostly
 * filled with it, and the bow attack itself takes some milliseconds before the
 * pitch is stable. On top of that, a metronome click reaches the player's ears
 * late by the audio output latency. Both push a *correct* player's frames
 * later than the printed onset, so every window below is shifted by
 * `shift = detectionLagMs + extraLatencyMs`, and a reported timing offset has
 * that shift already removed (an offset of 0 means "exactly on the click").
 *
 * ## The rules for one note
 *
 * Let `onset` be the note's plan onset, `tol` its timing tolerance and
 * `dwell` the time it must be held (see the constants below).
 *
 *  - A frame is *in tune* for the note when it passes the shared confidence /
 *    range gate and is within the cents tolerance of the note's pitch.
 *  - A *run* is an unbroken sequence of in-tune frames; any other frame (gated
 *    out, off pitch, silence) ends it. This is the same strict continuity as
 *    `TargetNoteDwellTracker`: "arrived and held", not an average with gaps.
 *  - A run that starts at plan time `T` has
 *    `timingOffsetMs = T - shift - onset`; it is *on time* iff
 *    `|timingOffsetMs| <= tol`.
 *  - **Hit**: the moment an on-time run has lasted `dwell`. Resolved at once,
 *    during the note, so feedback does not wait for the note to end.
 *  - A run that started before the window (offset < -tol) can never count; it
 *    is remembered as *early*, and a later, separate run inside the window
 *    still can (the player re-attacked). A run that starts after the window
 *    (offset > tol) is *late*.
 *  - Each note is watched from `monitorOpen = acceptStart - 2 * tol`, so a run
 *    that starts early is seen to start, until its `deadline = acceptEnd + dwell`
 *    (the latest instant an on-time run could still complete). At the
 *    deadline an unresolved note becomes **missed**, with the first reason that
 *    applies: `late`, `early`, `wrong-pitch`, `not-played`.
 *  - **Repeated pitch**: if the previous note has the same pitch, a run
 *    already in progress when the window opens counts as starting exactly on
 *    the onset (offset 0), so one held pitch through "C C C" earns credit for
 *    each. We deliberately do not demand a release in this mode, unlike the
 *    waiting modes: a real bow change is not reliably visible to the detector,
 *    and in a timed mode the player cannot retry, so punishing a re-articulation
 *    the detector happened to miss (or merge) would be wrong more often than
 *    right.
 *  - Notes are independent evaluations; one frame can resolve several notes
 *    (a fast passage with overlapping windows).
 *
 * ## Known limits (by design of the rules above)
 *
 *  - Lateness can only be *diagnosed* up to `tol + dwell` after the beat (400 ms
 *    at 60 bpm); a note that sounds later than its deadline is never seen in its
 *    own window, so it reads "not played" (or "wrong note" if it lands on the
 *    window of a later one). The result is final at the deadline by design: a
 *    missed note is reported while the player can still react.
 *  - Windows overlap on fast passages (the tolerance can exceed the note
 *    spacing), so two consecutive notes of the SAME pitch can both be credited by
 *    a single sounding. Different pitches cannot: pitch discriminates.
 *  - The session finishes when the last note is decided, which can be before
 *    the music itself has ended (the final note is hit one dwell after its
 *    onset). The caller owns the metronome and decides when to stop clicking.
 *
 * See the individual constants for the reasoning behind the numbers, and the
 * "Judgment call" notes inline for the places this goes beyond the bare rules:
 * a late run is remembered even if it ends early, and a trustworthy off-pitch
 * frame only counts as a "wrong note" if it is not the neighbouring note.
 */

import {
  DEFAULT_MIN_DWELL_TIME_MS,
  centsOffTarget,
  gateReading,
  isWithinTolerance,
} from '../scoring/scoring.js';
import type { GateResult, PitchReading, ScoringConfig } from '../scoring/scoring.js';
import type { PlayAlongNote, PlayAlongPlan } from './play-along-plan.js';
import { summarizePlayAlongResults } from './play-along-summary.js';
import type { PlayAlongSummary } from './play-along-summary.js';

/**
 * How long after a bow lands the pitch detector first reports the note, ms.
 *
 * Default 60 ms. The dsp-ts pipeline analyses a 2048-sample window (46 ms at
 * 44.1 kHz) every 512 samples (11.6 ms): a note is only reported with
 * confidence once the window is mostly filled with it, and the bow attack adds
 * some 10-20 ms before the pitch is even stable. 60 ms is that sum, rounded --
 * a deliberately round number to tune against a real instrument, not a
 * measured constant. If it is too small, every note reads a little late; too
 * large, a little early; tolerances of 100-250 ms absorb a 30 ms error.
 */
export const DEFAULT_PLAY_ALONG_DETECTION_LAG_MS = 60;

/**
 * Timing tolerance (ms) is `TIMING_TOLERANCE_BEAT_FRACTION` of a metronome
 * beat, clamped to [MIN, MAX]. A fraction of the beat because lateness is felt
 * relative to the pulse: 100 ms off is a disaster at 160 bpm and nothing at
 * 40 bpm. 0.4 of a beat is a generous, beginner-friendly "roughly on time".
 */
export const TIMING_TOLERANCE_BEAT_FRACTION = 0.4;

/**
 * Lower clamp: below ~100 ms the detector's own jitter (one hop is 11.6 ms,
 * and the lag varies by tens of ms with attack and string) makes "on time"
 * unmeasurable, so a fast piece is not allowed to demand more precision than
 * the measurement has.
 */
export const MIN_TIMING_TOLERANCE_MS = 100;

/**
 * Upper clamp: at very slow tempos 0.4 of a beat is a whole second; beyond
 * ~250 ms "roughly on time" stops meaning anything and the player is simply
 * not following the click.
 */
export const MAX_TIMING_TOLERANCE_MS = 250;

/**
 * A note must be held for `NOTE_DWELL_FRACTION` of its own length (capped by
 * `minDwellTimeMs`, floored by `MIN_NOTE_DWELL_MS`). The usual 150 ms dwell of
 * the waiting modes would be longer than a sixteenth note at 100 bpm
 * (150 ms), so it scales with the note: 60% of the sounding time leaves the
 * remaining 40% for the articulation gap and bow-change dropout that real
 * playing has between notes.
 */
export const NOTE_DWELL_FRACTION = 0.6;

/**
 * Floor for the per-note dwell. Three analysis hops (~35 ms) is what the
 * onset segmenter itself needs before it believes a note exists, so asking for
 * less would let a single stray frame score. 40 ms is that, rounded up. (If
 * the configured `minDwellTimeMs` is below this, the configured value wins.)
 */
export const MIN_NOTE_DWELL_MS = 40;

/**
 * Everything `ScoringConfig` offers applies to the per-frame pitch decision
 * (`inTuneCentsTolerance`, `minConfidence`, `minFrequencyHz`, `maxFrequencyHz`).
 * `a4Hz` has no effect here: each note's target frequency is fixed by the plan.
 */
export interface PlayAlongConfig extends ScoringConfig {
  /** See `DEFAULT_PLAY_ALONG_DETECTION_LAG_MS`. Finite and >= 0. */
  readonly detectionLagMs?: number;
  /** Extra delay to compensate, e.g. the audio output latency of the click. Finite and >= 0; default 0. Total shift = `detectionLagMs + extraLatencyMs`. */
  readonly extraLatencyMs?: number;
  /** Fixed timing tolerance for every note, ms (> 0). Default: per note, `clamp(0.4 * note.beatMs, 100, 250)`. */
  readonly timingToleranceMs?: number;
  /** Upper bound of the per-note dwell, ms (> 0); default `DEFAULT_MIN_DWELL_TIME_MS` (150). The dwell for a note is `clamp(0.6 * noteLength, 40, minDwellTimeMs)`. */
  readonly minDwellTimeMs?: number;
}

export type PlayAlongPhase = 'idle' | 'count-in' | 'playing' | 'finished';

export type PlayAlongMissReason = 'not-played' | 'wrong-pitch' | 'early' | 'late';

export type PlayAlongNoteResult =
  | { readonly index: number; readonly status: 'pending' }
  | {
      readonly index: number;
      readonly status: 'hit';
      /** Negative = early, positive = late; the detection lag is already removed. */
      readonly timingOffsetMs: number;
    }
  | {
      readonly index: number;
      readonly status: 'missed';
      readonly reason: PlayAlongMissReason;
      /** Set for `early` / `late`: how far from the beat the run started. */
      readonly timingOffsetMs: number | undefined;
    };

export interface PlayAlongUpdate {
  readonly phase: PlayAlongPhase;
  /** Plan time of this frame: negative during the count-in. */
  readonly timeMs: number;
  /** Where in the piece this frame is, in whole notes (negative during the count-in). */
  readonly positionWhole: number;
  /** Index into `plan.beats` of the latest beat with `tMs <= timeMs`; -1 if none yet. */
  readonly beatIndex: number;
  /** The last note whose onset is <= `timeMs`. */
  readonly dueNoteIndex: number | undefined;
  /** The first note whose onset is > `timeMs`. */
  readonly nextNoteIndex: number | undefined;
  /**
   * 0..1 progress of the best on-time in-tune hold among the notes currently
   * being evaluated, for a UI bar. A note that is hit by this very frame counts
   * as 1, so the bar visibly completes. Holds that can no longer count (they
   * started before the window) show nothing: a full bar that scores nothing
   * would be a lie.
   */
  readonly dwellFraction: number;
  /** Notes whose result became final in THIS update (each note appears in exactly one update over a run). */
  readonly resolved: readonly PlayAlongNoteResult[];
  readonly finished: boolean;
}

// --- Internals ------------------------------------------------------------------

/** Per-note constants, fixed once from the plan and config. All times are plan time, ms. */
interface NoteWindow {
  readonly frequencyHz: number;
  readonly previousHz: number | undefined;
  readonly nextHz: number | undefined;
  readonly onsetMs: number;
  readonly tolMs: number;
  readonly dwellMs: number;
  /** Earliest on-time run start. */
  readonly acceptStart: number;
  /** Latest on-time run start. */
  readonly acceptEnd: number;
  /** Frames are examined from here, so a run that starts early is seen to start. */
  readonly monitorOpen: number;
  /** Off-pitch frames only count as "wrong note" evidence from here. */
  readonly wrongFrom: number;
  /** The latest instant an on-time run can complete; the note is decided by here. */
  readonly deadline: number;
  /** The previous note has the same pitch (see "Repeated pitch" above). */
  readonly repeatsPrevious: boolean;
}

/** Per-note mutable tracking. */
interface NoteState {
  /** The window has opened (a frame at or after `acceptStart` has been seen). */
  windowOpened: boolean;
  /**
   * Plan time the current in-tune run started; undefined = no run. For a held
   * repeated pitch this is rewritten to the onset (+ shift) when the window opens.
   */
  runStart: number | undefined;
  /** Offset of the latest run that started before the window. */
  earlyOffset: number | undefined;
  /** Offset of the first run that started after the window. */
  lateOffset: number | undefined;
  /** An off-pitch (but trustworthy) frame was heard around this note. */
  wrongSeen: boolean;
}

const NO_RESOLVED: readonly PlayAlongNoteResult[] = Object.freeze([]);

function finiteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`PlayAlongSession: ${name} must be finite and >= 0, got ${value}`);
  }
}

function finitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`PlayAlongSession: ${name} must be finite and > 0, got ${value}`);
  }
}

/** Offsets below a micro-millisecond are float noise (and `-0`); report them as exactly 0. */
function cleanOffset(offsetMs: number): number {
  return Math.abs(offsetMs) < 1e-6 ? 0 : offsetMs;
}

export class PlayAlongSession {
  readonly plan: PlayAlongPlan;
  private readonly config: PlayAlongConfig;
  private readonly shiftMs: number;
  private readonly windows: readonly NoteWindow[];
  /** Note indices ordered by `monitorOpen` (so notes open in time order even when tolerances differ). */
  private readonly openOrder: readonly number[];

  private _phase: PlayAlongPhase = 'idle';
  private _zeroMs: number | undefined;
  private _results: PlayAlongNoteResult[] = [];
  private states: NoteState[] = [];
  private active: number[] = [];
  private openPointer = 0;
  private beatPointer = -1;
  private duePointer = -1;
  private resolvedCount = 0;
  private lastTimestampMs: number | undefined;
  private lastUpdate: PlayAlongUpdate | undefined;

  constructor(plan: PlayAlongPlan, config: PlayAlongConfig = {}) {
    const detectionLagMs = config.detectionLagMs ?? DEFAULT_PLAY_ALONG_DETECTION_LAG_MS;
    const extraLatencyMs = config.extraLatencyMs ?? 0;
    const maxDwellMs = config.minDwellTimeMs ?? DEFAULT_MIN_DWELL_TIME_MS;
    finiteNonNegative('detectionLagMs', detectionLagMs);
    finiteNonNegative('extraLatencyMs', extraLatencyMs);
    finitePositive('minDwellTimeMs', maxDwellMs);
    if (config.timingToleranceMs !== undefined) {
      finitePositive('timingToleranceMs', config.timingToleranceMs);
    }

    this.plan = plan;
    this.config = config;
    this.shiftMs = detectionLagMs + extraLatencyMs;

    const notes = plan.notes;
    this.windows = notes.map((note, i) =>
      this.makeWindow(note, notes[i - 1], notes[i + 1], maxDwellMs),
    );
    this.openOrder = notes
      .map((_, i) => i)
      .sort((a, b) => this.windows[a]!.monitorOpen - this.windows[b]!.monitorOpen || a - b);
    this.resetRun();
  }

  private makeWindow(
    note: PlayAlongNote,
    previous: PlayAlongNote | undefined,
    next: PlayAlongNote | undefined,
    maxDwellMs: number,
  ): NoteWindow {
    const tolMs =
      this.config.timingToleranceMs ??
      Math.min(
        MAX_TIMING_TOLERANCE_MS,
        Math.max(MIN_TIMING_TOLERANCE_MS, TIMING_TOLERANCE_BEAT_FRACTION * note.beatMs),
      );
    // The configured maximum always wins over the floor (a caller asking for a 20 ms dwell gets 20).
    const dwellMs = Math.min(
      maxDwellMs,
      Math.max(MIN_NOTE_DWELL_MS, NOTE_DWELL_FRACTION * (note.endMs - note.onsetMs)),
    );
    const acceptStart = note.onsetMs + this.shiftMs - tolMs;
    const acceptEnd = note.onsetMs + this.shiftMs + tolMs;
    return {
      frequencyHz: note.frequencyHz,
      previousHz: previous?.frequencyHz,
      nextHz: next?.frequencyHz,
      onsetMs: note.onsetMs,
      tolMs,
      dwellMs,
      acceptStart,
      acceptEnd,
      monitorOpen: acceptStart - 2 * tolMs,
      wrongFrom: acceptStart - tolMs,
      deadline: acceptEnd + dwellMs,
      repeatsPrevious: previous !== undefined && previous.midi === note.midi,
    };
  }

  /** The caller-clock timestamp at which plan time 0 occurs (set by `start`); `undefined` before the first `start`. */
  get zeroMs(): number | undefined {
    return this._zeroMs;
  }

  get phase(): PlayAlongPhase {
    return this._phase;
  }

  /** Per-note results (live array; the result objects themselves are immutable and replaced when a note resolves). */
  get results(): readonly PlayAlongNoteResult[] {
    return this._results;
  }

  summary(): PlayAlongSummary {
    return summarizePlayAlongResults(this._results);
  }

  /**
   * Begins (or restarts) a run. `zeroMs` is the caller-clock timestamp at which
   * plan time 0 -- the start of the music -- occurs; the count-in therefore
   * begins at `zeroMs - plan.countInMs`. Resets all results.
   *
   * @throws RangeError if `zeroMs` is not finite.
   */
  start(zeroMs: number): void {
    if (!Number.isFinite(zeroMs)) {
      throw new RangeError(`PlayAlongSession.start: zeroMs must be finite, got ${zeroMs}`);
    }
    this._zeroMs = zeroMs;
    this.resetRun();
    this._phase =
      this.plan.notes.length === 0 ? 'finished' : this.plan.countInMs > 0 ? 'count-in' : 'playing';
  }

  /** Ends the run now. Notes that were not yet decided stay `pending`; later `update` calls only report position. */
  stop(): void {
    this._phase = 'finished';
  }

  private resetRun(): void {
    this._results = this.plan.notes.map((_, index) => ({ index, status: 'pending' }) as const);
    this.states = this.plan.notes.map(() => ({
      windowOpened: false,
      runStart: undefined,
      earlyOffset: undefined,
      lateOffset: undefined,
      wrongSeen: false,
    }));
    this.active = [];
    this.openPointer = 0;
    this.beatPointer = -1;
    this.duePointer = -1;
    this.resolvedCount = 0;
    this.lastTimestampMs = undefined;
    this.lastUpdate = undefined;
  }

  /**
   * Feeds one detector frame. `timestampMs` is on the same clock as `start`'s
   * `zeroMs`. Never throws:
   *  - before `start`, returns an `idle` update;
   *  - a frame whose timestamp is earlier than the previous one (or not a finite
   *    number) is ignored and the latest update is returned again, with an empty
   *    `resolved` so no note is ever reported twice;
   *  - after the run is finished, frames only advance the position fields.
   */
  update(reading: PitchReading, timestampMs: number): PlayAlongUpdate {
    if (this._zeroMs === undefined) {
      return this.idleUpdate();
    }
    if (
      !Number.isFinite(timestampMs) ||
      (this.lastTimestampMs !== undefined && timestampMs < this.lastTimestampMs)
    ) {
      return this.repeatLastUpdate();
    }
    this.lastTimestampMs = timestampMs;
    const t = timestampMs - this._zeroMs;

    this.advancePointers(t);

    let resolved: readonly PlayAlongNoteResult[] = NO_RESOLVED;
    let dwellFraction = 0;
    if (this._phase !== 'finished') {
      const outcome = this.scoreFrame(reading, t);
      resolved = outcome.resolved;
      dwellFraction = outcome.dwellFraction;
      if (this.resolvedCount === this.plan.notes.length) {
        this._phase = 'finished';
      } else {
        this._phase = t < 0 ? 'count-in' : 'playing';
      }
    }

    const update = this.makeUpdate(t, dwellFraction, resolved);
    this.lastUpdate = update;
    return update;
  }

  // --- Frame scoring ---

  private scoreFrame(
    reading: PitchReading,
    t: number,
  ): { resolved: readonly PlayAlongNoteResult[]; dwellFraction: number } {
    // Open every note whose monitoring window has begun. A note opened and already past its
    // deadline (a long gap between frames) is still resolved below, from this one frame.
    while (
      this.openPointer < this.openOrder.length &&
      this.windows[this.openOrder[this.openPointer]!]!.monitorOpen <= t
    ) {
      this.active.push(this.openOrder[this.openPointer]!);
      this.openPointer++;
    }
    if (this.active.length === 0) {
      return { resolved: NO_RESOLVED, dwellFraction: 0 };
    }

    // Gate once per frame; each note only adds its own pitch comparison.
    const gated: GateResult = reading ? gateReading(reading, this.config) : { ok: false };

    let resolved: PlayAlongNoteResult[] | undefined;
    let dwellFraction = 0;
    let write = 0;
    for (let read = 0; read < this.active.length; read++) {
      const i = this.active[read]!;
      const result = this.evaluateNote(i, t, gated);
      if (result !== undefined) {
        this._results[i] = result;
        this.resolvedCount++;
        (resolved ??= []).push(result);
        if (result.status === 'hit') dwellFraction = 1;
      } else {
        this.active[write++] = i;
        dwellFraction = Math.max(dwellFraction, this.holdProgress(i, t));
      }
    }
    this.active.length = write;

    if (resolved !== undefined && resolved.length > 1) {
      resolved.sort((a, b) => a.index - b.index);
    }
    return { resolved: resolved ?? NO_RESOLVED, dwellFraction };
  }

  /** The offset (ms) of the note's current run: start - shift - onset (exactly 0 for a held repeated pitch, which `cleanOffset` guarantees despite float noise). */
  private runOffset(w: NoteWindow, st: NoteState): number {
    return cleanOffset(st.runStart! - this.shiftMs - w.onsetMs);
  }

  /** Progress of an on-time hold (0 when there is none, or when it started outside the window). */
  private holdProgress(i: number, t: number): number {
    const w = this.windows[i]!;
    const st = this.states[i]!;
    if (st.runStart === undefined || Math.abs(this.runOffset(w, st)) > w.tolMs) {
      return 0;
    }
    return Math.min(1, Math.max(0, (t - st.runStart) / w.dwellMs));
  }

  /** True when a trustworthy off-pitch frame is just the player sounding the previous or next note of the piece. */
  private explainedByNeighbour(w: NoteWindow, frequencyHz: number): boolean {
    return (
      (w.previousHz !== undefined &&
        isWithinTolerance(centsOffTarget(frequencyHz, w.previousHz), this.config)) ||
      (w.nextHz !== undefined &&
        isWithinTolerance(centsOffTarget(frequencyHz, w.nextHz), this.config))
    );
  }

  /** A run ended: if it began before the window it was early, and that is remembered. */
  private endRun(w: NoteWindow, st: NoteState): void {
    const offset = this.runOffset(w, st);
    if (offset < -w.tolMs) {
      st.earlyOffset = offset;
    }
    st.runStart = undefined;
  }

  /** Processes one frame for one note; returns its final result if this frame decides it. */
  private evaluateNote(i: number, t: number, gated: GateResult): PlayAlongNoteResult | undefined {
    const w = this.windows[i]!;
    const st = this.states[i]!;

    // The window opens: on a repeated pitch, a hold that is already going counts as starting
    // on the onset (the held-through "C C C" case).
    if (!st.windowOpened && t >= w.acceptStart) {
      st.windowOpened = true;
      if (w.repeatsPrevious && st.runStart !== undefined) {
        st.runStart = w.onsetMs + this.shiftMs;
      }
    }

    const inTune =
      gated.ok && isWithinTolerance(centsOffTarget(gated.frequencyHz, w.frequencyHz), this.config);

    if (inTune) {
      if (st.runStart === undefined) {
        st.runStart = t;
        const offset = this.runOffset(w, st);
        // Judgment call: a late run is remembered even if it ends before the deadline, so a
        // player who plays the note late but briefly is told "late", not "not played".
        if (offset > w.tolMs && st.lateOffset === undefined) {
          st.lateOffset = offset;
        }
      }
    } else {
      if (st.runStart !== undefined) {
        this.endRun(w, st);
      }
      // Judgment call: a trustworthy off-pitch frame is "wrong note" evidence only if it is
      // not simply the neighbouring note of the piece. Without this, the previous note's tail
      // (inside every note's evidence window) would turn every skipped note into a "wrong
      // note" instead of "not played".
      if (gated.ok && t >= w.wrongFrom && !this.explainedByNeighbour(w, gated.frequencyHz)) {
        st.wrongSeen = true;
      }
    }

    // Hit: an on-time run that has lasted long enough.
    if (st.runStart !== undefined) {
      const offset = this.runOffset(w, st);
      if (Math.abs(offset) <= w.tolMs && t - st.runStart >= w.dwellMs) {
        return { index: i, status: 'hit', timingOffsetMs: offset };
      }
    }

    // Deadline: decide why it was missed. A hold still going that started outside the window
    // is classified now (an early one that never ended; a late one was noted when it began).
    if (t >= w.deadline) {
      if (st.runStart !== undefined) {
        const offset = this.runOffset(w, st);
        if (offset < -w.tolMs) st.earlyOffset = offset;
      }
      if (st.lateOffset !== undefined) {
        return { index: i, status: 'missed', reason: 'late', timingOffsetMs: st.lateOffset };
      }
      if (st.earlyOffset !== undefined) {
        return { index: i, status: 'missed', reason: 'early', timingOffsetMs: st.earlyOffset };
      }
      return {
        index: i,
        status: 'missed',
        reason: st.wrongSeen ? 'wrong-pitch' : 'not-played',
        timingOffsetMs: undefined,
      };
    }
    return undefined;
  }

  // --- Position bookkeeping ---

  private advancePointers(t: number): void {
    const beats = this.plan.beats;
    while (this.beatPointer + 1 < beats.length && beats[this.beatPointer + 1]!.tMs <= t) {
      this.beatPointer++;
    }
    const notes = this.plan.notes;
    while (this.duePointer + 1 < notes.length && notes[this.duePointer + 1]!.onsetMs <= t) {
      this.duePointer++;
    }
  }

  private makeUpdate(
    t: number,
    dwellFraction: number,
    resolved: readonly PlayAlongNoteResult[],
  ): PlayAlongUpdate {
    const noteCount = this.plan.notes.length;
    return {
      phase: this._phase,
      timeMs: t,
      positionWhole: this.plan.wholeAtMs(t),
      beatIndex: this.beatPointer,
      dueNoteIndex: this.duePointer >= 0 ? this.duePointer : undefined,
      nextNoteIndex: this.duePointer + 1 < noteCount ? this.duePointer + 1 : undefined,
      dwellFraction,
      resolved,
      finished: this._phase === 'finished',
    };
  }

  private idleUpdate(): PlayAlongUpdate {
    return {
      phase: this._phase,
      timeMs: 0,
      positionWhole: 0,
      beatIndex: -1,
      dueNoteIndex: undefined,
      nextNoteIndex: this.plan.notes.length > 0 ? 0 : undefined,
      dwellFraction: 0,
      resolved: NO_RESOLVED,
      finished: this._phase === 'finished',
    };
  }

  private repeatLastUpdate(): PlayAlongUpdate {
    const last = this.lastUpdate;
    if (last === undefined) {
      return this.idleUpdate();
    }
    // Same state, but nothing newly resolved: a consumer collecting `resolved` must never see a note twice.
    return {
      ...last,
      phase: this._phase,
      finished: this._phase === 'finished',
      resolved: NO_RESOLVED,
    };
  }
}
