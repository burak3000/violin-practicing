/**
 * One timed play-along run, end to end, with no platform in it.
 *
 * `PlayAlongPlan` (the beat grid and note timings) and `PlayAlongSession` (the
 * scoring) are pure and know nothing about clocks, clicks or screens. A run
 * needs more than them: someone has to pick when "now" is, start the metronome
 * click on time, keep a cheap, render-ready description of where the player is
 * and how each note went, and turn the finished run into text. That is the same
 * on desktop and mobile, so it lives here once; each app supplies only its
 * clock, an optional way to sound a click, and drawing.
 *
 * ## Two clocks, deliberately
 *
 * - **Display time** (where the playhead is, which beat is sounding) comes from
 *   the platform clock `nowMs()` on every `getView()`. It does not depend on
 *   audio frames arriving, so the count-in runs and the playhead glides at the
 *   screen's own rate even if the analysis stream stalls.
 * - **Scoring time** comes from the frames' own timestamps (`handleFrame`),
 *   because that is the clock the pitch readings were stamped with. If frames
 *   stop, nothing is scored and `signalLost` turns on so the UI can say why
 *   instead of silently marking every note missed.
 *
 * Both are the same clock domain (desktop: epoch ms; mobile: `performance.now()`),
 * which is why the caller passes `nowMs`.
 */

import { spellMidiInKey, formatSpellingLabel } from '../notation/note-spelling.js';
import type { AbcPiece } from '../abc/abc-score.js';
import { centsOffTarget, type PitchReading } from '../scoring/scoring.js';
import type { FingerTunerReading } from '../tuner/finger-tuner.js';
import type { SequenceNote } from '../sequence/sequence-generator.js';
import { ClickScheduler, type ScheduledClick } from './click-scheduler.js';
import {
  buildPlayAlongPlan,
  type PlayAlongPlan,
  type PlayAlongPlanOptions,
} from './play-along-plan.js';
import {
  DEFAULT_PLAY_ALONG_DETECTION_LAG_MS,
  PlayAlongSession,
  type PlayAlongConfig,
} from './play-along-session.js';
import {
  describeMiss,
  describeSummary,
  describeTendency,
  formatTempoMark,
  summarizePlayAlongResults,
} from './play-along-summary.js';

/**
 * Time between pressing Start and the first count-in click: long enough to get
 * the bow ready and for the audio engine to have the first click scheduled,
 * short enough not to feel like the button did nothing.
 */
export const DEFAULT_PLAY_ALONG_LEAD_MS = 600;

/** No analysis frame for this long while running: the input has stopped or stalled (a normal frame arrives every ~12ms). */
export const SIGNAL_LOST_AFTER_MS = 1500;

/** How many upcoming note names the letters display previews. */
const UPCOMING_LABEL_COUNT = 4;

export type PlayAlongRunPhase = 'idle' | 'count-in' | 'playing' | 'finished';

/** How a note is drawn: `due` is the one the player should be on right now. */
export type PlayAlongNoteDisplayState = 'pending' | 'due' | 'hit' | 'missed';

export interface PlayAlongRunnerOptions {
  readonly piece: AbcPiece;
  readonly tempoBpm: number;
  readonly countInBeats: number;
  /** The platform clock, in the same domain as the timestamps passed to `handleFrame`. */
  readonly nowMs: () => number;
  /** Sounds a click at `atMs` (that clock). Omit for a silent (visual-only) run. */
  readonly click?: (atMs: number, accent: boolean) => void;
  /** Delay before the first count-in click. Default `DEFAULT_PLAY_ALONG_LEAD_MS`. */
  readonly leadMs?: number;
  /** Scoring settings; `extraLatencyMs` is the place for the click's output latency. */
  readonly config?: PlayAlongConfig;
  /** Injected timers for the click scheduler (tests). */
  readonly setIntervalFn?: (callback: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

export interface PlayAlongBeatView {
  /** 1-based beat within the bar. */
  readonly inBar: number;
  readonly beatsPerBar: number;
  readonly accent: boolean;
  /** 0..1: how far through this beat we are (for animating a pulse). */
  readonly progress: number;
}

export interface PlayAlongMissView {
  readonly noteIndex: number;
  /** "Bar 3, beat 2 · F♯4 — late by 310 ms" */
  readonly text: string;
}

export interface PlayAlongSummaryView {
  /** "12 of 16 notes on time (75%)" */
  readonly headline: string;
  /** "You tend to play a little late (+45 ms on average)"; undefined when there is too little to say. */
  readonly tendency: string | undefined;
  readonly misses: readonly PlayAlongMissView[];
  readonly missedNoteIndices: readonly number[];
  readonly hits: number;
  readonly total: number;
  /** False when the run was stopped before every note was judged. */
  readonly complete: boolean;
}

export interface PlayAlongRunView {
  readonly phase: PlayAlongRunPhase;
  /** Plan time now (negative during the count-in), from the platform clock. */
  readonly timeMs: number;
  /** Where the playhead is, in whole notes (negative during the count-in), from the platform clock. */
  readonly positionWhole: number;
  /** While counting in: the beats left including the one sounding (4, 3, 2, 1); otherwise undefined. */
  readonly countInRemaining: number | undefined;
  /** The beat sounding now (during the count-in too); undefined before the first click. */
  readonly beat: PlayAlongBeatView | undefined;
  /** "♩ = 92". */
  readonly tempoText: string;
  /** "Bar 3 of 16", "Pickup", or "Count-in". */
  readonly progressText: string;
  /**
   * One state per practice note. The array keeps its identity until a state
   * actually changes (a note resolves, the due note moves), so a renderer can
   * redraw the score only when `noteStatesVersion` changes.
   */
  readonly noteStates: readonly PlayAlongNoteDisplayState[];
  readonly noteStatesVersion: number;
  readonly dueNoteIndex: number | undefined;
  /** The note the player is on or about to play, as the sheet spells it ("B♭4"); '' when the piece is over. */
  /** Index of the note `targetLabel` names (the due note, or the next one between notes); undefined at the end. */
  readonly targetNoteIndex: number | undefined;
  readonly targetLabel: string;
  readonly upcomingLabels: readonly string[];
  /** "Hearing B♭4 (+8c from target)", "No signal", ... */
  readonly liveFeedbackText: string;
  /** 0..1 progress of the current in-tune hold. */
  readonly dwellFraction: number;
  /** True while running if the analysis frames have stopped arriving. */
  readonly signalLost: boolean;
  /** Present once the run has ended (every note judged, or stopped). */
  readonly summary: PlayAlongSummaryView | undefined;
}

function formatSignedCents(cents: number): string {
  const rounded = Math.round(cents);
  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded)}c`;
}

/** The practice sequence made of just the notes at `indices` (in order), for "practice the missed notes". They are practiced one at a time like any sequence; neighbours in the piece are not included. */
export function notesAtIndices(
  piece: AbcPiece,
  indices: readonly number[],
): readonly SequenceNote[] {
  return indices.flatMap((index) => {
    const note = piece.notes[index];
    return note === undefined ? [] : [note];
  });
}

export class PlayAlongRunner {
  readonly plan: PlayAlongPlan;
  readonly piece: AbcPiece;

  private readonly session: PlayAlongSession;
  private readonly nowMs: () => number;
  private readonly click: ((atMs: number, accent: boolean) => void) | undefined;
  private readonly leadMs: number;
  /** The lag between a note landing and the detector reporting it, plus the click's output latency: the shift the scorer applies. */
  private readonly shiftMs: number;
  private readonly setIntervalFn: ((callback: () => void, ms: number) => unknown) | undefined;
  private readonly clearIntervalFn: ((handle: unknown) => void) | undefined;

  private scheduler: ClickScheduler | undefined;
  private _phase: 'idle' | 'running' | 'finished' = 'idle';
  private startedAtMs = 0;
  private _zeroMs = 0;
  /** Time (plan ms) the display froze at, once the run ended. */
  private frozenTimeMs: number | undefined;

  private states: PlayAlongNoteDisplayState[];
  private statesVersion = 0;
  private dueIndex: number | undefined;

  private lastFrameAtMs: number | undefined;
  private liveFeedbackText = '';
  private dwellFraction = 0;
  private summaryView: PlayAlongSummaryView | undefined;
  private completeRun = false;

  constructor(options: PlayAlongRunnerOptions) {
    const planOptions: PlayAlongPlanOptions = {
      tempoBpm: options.tempoBpm,
      countInBeats: options.countInBeats,
    };
    this.piece = options.piece;
    this.plan = buildPlayAlongPlan(options.piece, planOptions);
    this.session = new PlayAlongSession(this.plan, options.config ?? {});
    this.nowMs = options.nowMs;
    this.click = options.click;
    this.leadMs = options.leadMs ?? DEFAULT_PLAY_ALONG_LEAD_MS;
    this.shiftMs =
      (options.config?.detectionLagMs ?? DEFAULT_PLAY_ALONG_DETECTION_LAG_MS) +
      (options.config?.extraLatencyMs ?? 0);
    this.setIntervalFn = options.setIntervalFn;
    this.clearIntervalFn = options.clearIntervalFn;
    this.states = this.plan.notes.map(() => 'pending');
  }

  get phase(): 'idle' | 'running' | 'finished' {
    return this._phase;
  }

  /** The clock time at which the music starts (plan time 0). Only meaningful after `start()`. */
  get zeroMs(): number {
    return this._zeroMs;
  }

  /** Begins the run: the first count-in click sounds `leadMs` from now. Does nothing if already started. */
  start(): void {
    if (this._phase !== 'idle') return;
    this.startedAtMs = this.nowMs();
    this._zeroMs = this.startedAtMs + this.leadMs + this.plan.countInMs;
    this._phase = 'running';
    this.session.start(this._zeroMs);

    if (this.click) {
      const clicks: ScheduledClick[] = this.plan.beats.map((beat) => ({
        atMs: this._zeroMs + beat.tMs,
        accent: beat.accent,
      }));
      this.scheduler = new ClickScheduler({
        clicks,
        now: this.nowMs,
        schedule: this.click,
        ...(this.setIntervalFn ? { setIntervalFn: this.setIntervalFn } : {}),
        ...(this.clearIntervalFn ? { clearIntervalFn: this.clearIntervalFn } : {}),
      });
      this.scheduler.start();
    }
  }

  /** Ends the run now (the Stop button). Notes not reached stay unjudged. Safe to call at any time. */
  stop(): void {
    if (this._phase !== 'running') return;
    this.session.stop();
    this.finish(false);
  }

  /** Feeds one analysis frame in. A no-op unless the run is going. */
  handleFrame(reading: PitchReading, rawReading: FingerTunerReading, timestampMs: number): void {
    if (this._phase !== 'running') return;
    this.lastFrameAtMs = this.nowMs();
    const update = this.session.update(reading, timestampMs);

    let changed = false;
    for (const result of update.resolved) {
      const next = result.status === 'hit' ? 'hit' : 'missed';
      if (this.states[result.index] !== next) {
        if (!changed) this.states = [...this.states];
        this.states[result.index] = next;
        changed = true;
      }
    }

    // The note the player should be on: the one whose onset has most recently passed.
    const due = update.dueNoteIndex;
    if (due !== this.dueIndex) {
      if (this.dueIndex !== undefined && this.states[this.dueIndex] === 'due') {
        if (!changed) this.states = [...this.states];
        this.states[this.dueIndex] = 'pending';
        changed = true;
      }
      this.dueIndex = due;
    }
    if (due !== undefined && this.states[due] === 'pending') {
      if (!changed) this.states = [...this.states];
      this.states[due] = 'due';
      changed = true;
    }
    if (changed) this.statesVersion += 1;

    this.dwellFraction = update.dwellFraction;
    // Judge what is heard against the note the player is on or is about to play. The frame describes
    // what the player did `shiftMs` ago (detector lag, click latency -- the same shift the scorer
    // applies), so "the note being played" is the last one whose onset is not after that time, and
    // "about to play" the one after it. Between those two the closer pitch is the one meant: that
    // keeps the line right through an early or late attack instead of guessing from the clock.
    const target = this.feedbackTarget(update.timeMs - this.shiftMs, rawReading);
    this.liveFeedbackText = target ? this.describeHearing(rawReading, target.frequencyHz) : '';

    if (update.finished) this.finish(true);
  }

  /** The note being played at `playerTimeMs`, or the one coming next if the pitch heard is closer to it. */
  private feedbackTarget(playerTimeMs: number, rawReading: FingerTunerReading) {
    const notes = this.plan.notes;
    const nextIndex = this.nextNoteIndex(playerTimeMs);
    const next = nextIndex === undefined ? undefined : notes[nextIndex];
    const current = nextIndex === undefined ? notes[notes.length - 1] : notes[nextIndex - 1];
    if (current && next && rawReading.status === 'reading') {
      const centsFrom = (note: { frequencyHz: number }) =>
        Math.abs(centsOffTarget(rawReading.frequencyHz, note.frequencyHz));
      return centsFrom(next) < centsFrom(current) ? next : current;
    }
    return current ?? next;
  }

  private describeHearing(rawReading: FingerTunerReading, targetHz: number): string {
    if (rawReading.status === 'no-signal') return 'No signal';
    if (rawReading.status === 'unclear') return 'Unclear signal…';
    const heard = formatSpellingLabel(spellMidiInKey(rawReading.note.midi, this.piece.keyAtStart));
    return `Hearing ${heard} (${formatSignedCents(centsOffTarget(rawReading.frequencyHz, targetHz))} from target)`;
  }

  private finish(complete: boolean): void {
    this._phase = 'finished';
    this.completeRun = complete;
    this.scheduler?.stop();
    this.frozenTimeMs = this.nowMs() - this._zeroMs;
    const results = this.session.results;
    const summary = summarizePlayAlongResults(results);
    this.summaryView = {
      headline: describeSummary(summary),
      tendency: describeTendency(summary),
      misses: summary.missedIndices.flatMap((index) => {
        const note = this.plan.notes[index];
        const result = results[index];
        return note && result ? [{ noteIndex: index, text: describeMiss(note, result) }] : [];
      }),
      missedNoteIndices: summary.missedIndices,
      hits: summary.hits,
      total: summary.total,
      complete: summary.pending === 0 && complete,
    };
  }

  /** The beat index (into `plan.beats`) of the latest beat at or before `timeMs`; -1 if none. Binary search: `getView` runs at screen rate. */
  private beatIndexAt(timeMs: number): number {
    const beats = this.plan.beats;
    let low = 0;
    let high = beats.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (beats[mid]!.tMs <= timeMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** What to show right now. Cheap enough to call every animation frame. */
  getView(): PlayAlongRunView {
    const running = this._phase === 'running';
    const timeMs =
      this.frozenTimeMs ??
      (this._phase === 'idle' ? -this.plan.countInMs - this.leadMs : this.nowMs() - this._zeroMs);
    const phase: PlayAlongRunPhase =
      this._phase === 'finished'
        ? 'finished'
        : this._phase === 'idle'
          ? 'idle'
          : timeMs < 0
            ? 'count-in'
            : 'playing';
    const positionWhole = this.plan.wholeAtMs(timeMs);

    // Beat sounding now.
    const beatIndex = this._phase === 'idle' ? -1 : this.beatIndexAt(timeMs);
    const beat = beatIndex >= 0 ? this.plan.beats[beatIndex]! : undefined;
    const nextBeat = beatIndex >= 0 ? this.plan.beats[beatIndex + 1] : undefined;
    const beatsPerBar = this.piece.meter.beatsPerBar;
    const beatView: PlayAlongBeatView | undefined = beat
      ? {
          inBar: beat.beatInBar,
          beatsPerBar,
          accent: beat.accent,
          progress: nextBeat
            ? Math.min(1, Math.max(0, (timeMs - beat.tMs) / (nextBeat.tMs - beat.tMs)))
            : 1,
        }
      : undefined;

    let countInRemaining: number | undefined;
    if (phase === 'count-in') {
      const countInBeats = this.plan.beats.filter((b) => b.countIn).length;
      countInRemaining = Math.max(1, countInBeats - Math.max(0, beatIndex));
      if (beatIndex < 0) countInRemaining = countInBeats;
    }

    const noteIndexForBar = this.dueIndex ?? this.nextNoteIndex(timeMs);
    const barNote = noteIndexForBar === undefined ? undefined : this.plan.notes[noteIndexForBar];
    let progressText = '';
    if (phase === 'count-in' || phase === 'idle') progressText = 'Count-in';
    else if (barNote) {
      progressText =
        barNote.barNumber === 0 ? 'Pickup' : `Bar ${barNote.barNumber} of ${this.lastBarNumber()}`;
    }

    const target = this.dueIndex !== undefined ? this.dueIndex : this.nextNoteIndex(timeMs);
    const upcomingStart = target === undefined ? this.plan.notes.length : target + 1;

    // No frame for a while, count-in included: capture is not running (or has stalled).
    const signalLost =
      running && this.nowMs() - (this.lastFrameAtMs ?? this.startedAtMs) > SIGNAL_LOST_AFTER_MS;

    return {
      phase,
      timeMs,
      positionWhole,
      countInRemaining,
      beat: beatView,
      tempoText: formatTempoMark({
        beatLengthWhole: this.piece.tempo.beatLengthWhole,
        bpm: this.plan.tempoBpm,
      }),
      progressText,
      noteStates: this.states,
      noteStatesVersion: this.statesVersion,
      dueNoteIndex: this.dueIndex,
      targetNoteIndex: target,
      targetLabel: target === undefined ? '' : (this.plan.notes[target]?.label ?? ''),
      upcomingLabels: this.plan.notes
        .slice(upcomingStart, upcomingStart + UPCOMING_LABEL_COUNT)
        .map((n) => n.label),
      liveFeedbackText: this.liveFeedbackText,
      dwellFraction: this.dwellFraction,
      signalLost,
      summary: this.summaryView,
    };
  }

  /** Index of the first note whose onset is after `timeMs` (binary search); undefined once past the last. */
  private nextNoteIndex(timeMs: number): number | undefined {
    const notes = this.plan.notes;
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (notes[mid]!.onsetMs > timeMs) high = mid;
      else low = mid + 1;
    }
    return low < notes.length ? low : undefined;
  }

  private lastBarNumber(): number {
    const last = this.plan.notes[this.plan.notes.length - 1];
    return last ? last.barNumber : 0;
  }

  /** True when the run ended because every note was judged (not because Stop was pressed). */
  get completed(): boolean {
    return this.completeRun;
  }
}
