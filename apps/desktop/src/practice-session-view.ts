/**
 * The shared "run one practice session" half of Playing Practice, extracted
 * out of `PlayingPracticeUi` (Phase 6/7) so a second mode -- ABC Notation
 * practice (`abc-practice-ui.ts`) -- can drive the exact same session
 * rendering and scoring without a copy of it. Given a note sequence it owns:
 * the `PracticeSessionController` (Playing Practice <-> Drilling hand-off),
 * one `PracticeAttemptTracker` per target note, the live "Hearing X (+Nc from
 * target)" line, the dwell bar, the "Nice!"/"Mastered!"/"Moving on" banner,
 * both escape-hatch buttons, and the "Sequence complete!" screen.
 *
 * It does not know where the sequence came from: `PlayingPracticeUi`
 * generates it procedurally (strings/pattern/direction/range), and
 * `AbcPracticeUi` builds it from an imported ABC file. Everything else -- the
 * design reasoning for Drilling reuse, the banner pause, the mastered-vs-
 * capped inference -- is unchanged from Phase 6/7 and documented in
 * `apps/desktop/CLAUDE.md`'s "Playing Practice UI (Phase 6)" and "Drilling UI
 * (Phase 7)" sections; the comments below keep the "why" next to the code
 * that depends on it.
 *
 * ## Phase 7 judgment calls that live here (unchanged by the extraction)
 *
 * - No per-drill-note role label ("neighbor below"...): `PracticeSession
 *   Controller.state`'s drilling variant exposes only `targetNote`, by
 *   design, and widening that shared state machine for a label wasn't worth
 *   it -- the target note and the progress counters change together in one
 *   `renderCurrentState()` call, which reads as deliberate progress.
 * - Mastered-vs-capped is inferred in the UI from already-public state
 *   (`applyResult`), not by changing `packages/core`'s API.
 * - Manual skip of a whole drill gets no banner (an intentional user action
 *   is already its own signal); give-up and skip-drill are mutually
 *   exclusive buttons.
 *
 * ## Repeated pitches (new with ABC)
 *
 * Scales never ask for the same pitch twice in a row, but a tune does ("C C G
 * G A A G"). Without care, a player still holding the note they just got
 * credit for would satisfy the next, identical target the moment it appeared.
 * When an attempt *succeeds* and the next target has the same pitch, the next
 * tracker is built with `requireReleaseFirst`: the player has to leave the
 * pitch (a gap, a bow change, a different note) before the dwell clock may
 * start. See `PracticeAttemptTracker`'s doc comment. It deliberately does not
 * apply after a *failed* attempt (Drilling reopens on the same note, and
 * nothing was credited that a held note could leak into). For the procedural
 * sequences this never triggers, so Playing Practice's behavior is unchanged.
 *
 * ## Real notation for an ABC piece (new with tempo/beats)
 *
 * `begin(notes, piece)` takes an optional `AbcPiece` -- only ABC practice
 * passes one (Playing Practice never does, so its letter labels such as "A#4"
 * and its single-note staff are exactly what they were). With a piece:
 *
 *  - *Letters* use the spelling the sheet uses ("B♭4", not "A#4") for the
 *    target, the "Next:" line and the "Hearing ..." line (the heard pitch is
 *    spelled in the piece's key, `spellMidiInKey`).
 *  - *Staff* draws the piece's real score (key signature, accidentals only
 *    where needed, note values, bar lines) in a window that starts at the
 *    target's bar, with the target highlighted, the notes before it in the same
 *    bar shown as done, and the following bars to the right. Drilling follows
 *    the drilled target's bar. Without a piece, or without the `score` element,
 *    the old rhythm-less staff is used.
 */

import {
  DEFAULT_MIN_DWELL_TIME_MS,
  PracticeAttemptTracker,
  PracticeSessionController,
  centsOffTarget,
  describeFinger,
  fingerMarkFor,
  fingerMarksOf,
  formatSpellingLabel,
  spellMidiInKey,
  staffSpellingOf,
  type AbcPiece,
  type FingerTunerReading,
  type PitchReading,
  type PracticeAttemptStatus,
  type PracticeSessionState,
  type SequenceNote,
  type StaffNote,
} from '@violin/core';
import { ScoreView } from './score-view.js';
import { renderStaff } from './staff-svg.js';

/**
 * How long the "Nice!" success banner stays up (measured in the same
 * worklet-timestamp domain as every other timing in this pipeline -- see
 * `handleAnalysisFrame`) before advancing to the next target. A UI-timing
 * constant, not a domain/scoring concern -- deliberately kept here rather
 * than in packages/core.
 */
const SUCCESS_PAUSE_MS = 700;

/** How many upcoming notes the optional "Next:" line previews. */
const UPCOMING_NOTE_COUNT = 4;

/**
 * How many notes after the target the staff is given to choose from. It draws
 * only as many as fit across the window at a readable spacing (a wide window
 * fits a dozen or more), so this just needs to be more than any screen shows.
 */
const STAFF_LOOKAHEAD_NOTES = 40;

/** Upper bound on the staff's height, so on a very tall window it doesn't grow without limit. */
const STAFF_MAX_HEIGHT_PX = 380;

export interface PracticeSessionElements {
  readonly session: HTMLElement;
  readonly progress: HTMLElement;
  readonly targetRoot: HTMLElement;
  readonly modeLabel: HTMLElement;
  readonly targetNote: HTMLElement;
  readonly liveFeedback: HTMLElement;
  readonly dwellFill: HTMLElement;
  readonly successBanner: HTMLElement;
  readonly giveUpBtn: HTMLButtonElement;
  readonly skipDrillBtn: HTMLButtonElement;
  readonly complete: HTMLElement;
  readonly restartBtn: HTMLButtonElement;
  /** Optional "Next: B4 C5 D5 E5" preview line (used by ABC practice, where seeing what's coming is part of reading a sheet). */
  readonly upcoming?: HTMLElement;
  /** Optional line under the big note name for the finger ("Finger 2", "Open string"); filled only when `begin` is told to show finger numbers. */
  readonly finger?: HTMLElement;
  /**
   * Optional container for the staff (treble clef) rendering of the target
   * note -- and, when `upcoming` is also provided, as many of the notes after
   * it as fit across the window (not just the four the "Next:" text names). Shown
   * instead of the big letter name when the note display is switched to
   * "staff" (see `setNoteDisplay`).
   */
  readonly staff?: HTMLElement;
  /**
   * Optional container for the real sheet music of an ABC piece (`begin`'s
   * `piece`), used instead of `staff` when a piece is being practiced.
   */
  readonly score?: HTMLElement;
}

/** How the target note is shown: its letter name ("D4") or on a staff. */
export type NoteDisplay = 'letters' | 'staff';

/** Mirrors renderer.ts's own `formatCents` (note.ts's `describeFrequency` sign convention) -- small enough that a shared export isn't worth the cross-file coupling. */
function formatSignedCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/**
 * What to show on the live "what am I currently hearing" line -- cents measured
 * from the *target* (centsOffTarget), not from the nearest note in general, so
 * the sign directly tells the player which way to adjust. With an ABC `piece`
 * the heard pitch is spelled the way the sheet's key would write it ("B♭4").
 */
function formatLiveFeedback(
  rawReading: FingerTunerReading,
  targetFrequencyHz: number,
  piece: AbcPiece | undefined,
): string {
  if (rawReading.status === 'no-signal') return 'No signal';
  if (rawReading.status === 'unclear') return 'Unclear signal…';
  const cents = centsOffTarget(rawReading.frequencyHz, targetFrequencyHz);
  const heard = piece
    ? formatSpellingLabel(spellMidiInKey(rawReading.note.midi, piece.keyAtStart))
    : rawReading.note.label;
  return `Hearing ${heard} (${formatSignedCents(cents)} from target)`;
}

/**
 * "Drilling: N of M correct in a row · attempt A of B" -- reuses
 * `#pp-progress` (Playing Practice's own "Note X of Y" line, see
 * `renderCurrentState()`) rather than a second, parallel progress element.
 * `attemptsUsed` counts *completed* attempts (`DrillingMachine.
 * reportOutcome` increments it before deciding the outcome -- see
 * packages/core), so the attempt currently in progress is `attemptsUsed +
 * 1`: 1-indexed for a human-friendly "attempt 1 of 12" on the very first
 * rep rather than "attempt 0 of 12".
 */
function formatDrillProgress(state: Extract<PracticeSessionState, { mode: 'drilling' }>): string {
  return `Drilling: ${state.consecutiveCorrect} of ${state.requiredConsecutiveCorrect} correct in a row · attempt ${
    state.attemptsUsed + 1
  } of ${state.maxAttempts}`;
}

export class PracticeSessionView {
  private notes: readonly SequenceNote[] = [];
  private controller: PracticeSessionController | undefined;
  private tracker: PracticeAttemptTracker | undefined;
  /** MIDI number of the target whose attempt just succeeded, until the next target is rendered -- see the "Repeated pitches" note in the module doc comment. */
  private lastSucceededMidi: number | undefined;
  /** Set while the "Nice!" banner is showing; `handleAnalysisFrame` ignores frames until this worklet-timestamp is reached, then advances. */
  private pauseUntilMs: number | undefined;
  private noteDisplay: NoteDisplay = 'letters';
  /** Whether the staff is currently the visible rendering (so a window resize knows to redraw it). */
  private staffShown = false;
  /** The notes the staff currently shows (target first), cached so the Letters/Staff switch can redraw without waiting for the next target. Updated only by `renderCurrentState`, so a banner pause keeps the just-finished note on screen like the letter does. */
  private staffNotes: readonly StaffNote[] | undefined;
  /** The ABC piece being practiced, if any (see "Real notation" above). */
  private piece: AbcPiece | undefined;
  private scoreView: ScoreView | undefined;
  /** When false a missed note moves straight on instead of starting a drill. Takes effect from the next miss. */
  private drillingEnabled = true;
  /** Whether finger numbers are shown (the ABC checkbox, as of `begin`). */
  private showFingers = false;
  /** Index (into the piece / `notes`) of the note the score highlights; undefined when there is nothing to show. */
  private scoreTargetIndex: number | undefined;
  /** True while drilling: the notes before the target are then not "done", so they are not coloured as such. */
  private scoreDrilling = false;
  /** Whether the real score is currently the visible rendering (so a window resize knows to redraw it). */
  private scoreShown = false;

  /** `onRestart` is called when the user presses the "Start a new sequence" button on the complete screen. */
  constructor(
    private readonly el: PracticeSessionElements,
    onRestart: () => void,
  ) {
    this.el.restartBtn.addEventListener('click', onRestart);
    this.el.giveUpBtn.addEventListener('click', () => {
      if (!this.tracker) return;
      // Date.now(): must be the same clock as `workletTimestampMs` (see
      // pitch-worklet-processor.ts), since applyResult() may schedule a
      // pause that later hops' timestamps are compared against.
      this.applyResult(this.tracker.giveUp(), Date.now());
    });
    this.el.skipDrillBtn.addEventListener('click', () => {
      // Bypasses PracticeAttemptTracker entirely (unlike giveUpBtn above) --
      // this abandons the whole drill via DrillingMachine.skip(), not just
      // the current rep: a different, stronger action, so a different control.
      if (!this.controller || this.controller.state.mode !== 'drilling') return;
      this.controller.skipDrill();
      this.renderCurrentState();
    });
    window.addEventListener('resize', () => {
      if (this.staffShown) this.drawStaff();
      if (this.scoreShown) this.drawScore();
    });
  }

  /** How a note reads on screen: the sheet's own spelling for an ABC piece, the sharps-only label otherwise. */
  private labelOf(note: SequenceNote): string {
    return this.piece ? formatSpellingLabel(staffSpellingOf(note)) : note.note.label;
  }

  /** Switches the target note between its letter name and the staff. Safe to call at any time, session or not. */
  /** Switches drilling on or off (default on): off means a missed note just moves on to the next note. */
  setDrillingEnabled(enabled: boolean): void {
    this.drillingEnabled = enabled;
  }

  /** Finger numbers on or off right now, mid-session included (the score redraws; the attempt in progress is untouched). */
  setFingersEnabled(on: boolean): void {
    this.showFingers = on;
    if (this.scoreView) this.scoreView.setFingers(on ? fingerMarksOf(this.notes) : undefined);
    const state = this.controller?.state;
    this.updateFingerLine(state && state.mode !== 'complete' ? state.targetNote : undefined);
    if (this.controller) this.applyNoteDisplay();
  }

  private updateFingerLine(target: SequenceNote | undefined): void {
    if (!this.el.finger) return;
    const mark = this.showFingers && target ? fingerMarkFor(target) : undefined;
    this.el.finger.textContent = describeFinger(mark);
  }

  setNoteDisplay(display: NoteDisplay): void {
    this.noteDisplay = display;
    this.applyNoteDisplay();
  }

  private applyNoteDisplay(): void {
    if (this.scoreView && this.el.score) {
      // Real sheet music for an ABC piece replaces both the letter and the single-note staff.
      const showScore = this.noteDisplay === 'staff' && this.scoreTargetIndex !== undefined;
      this.el.targetNote.hidden = showScore;
      if (this.el.staff) this.el.staff.hidden = true;
      this.el.score.hidden = !showScore;
      if (this.el.upcoming) this.el.upcoming.hidden = showScore;
      // The score carries its own finger digits; the text line is for the letter name and the plain staff.
      if (this.el.finger) this.el.finger.hidden = showScore;
      this.scoreShown = showScore;
      this.staffShown = false;
      if (showScore) this.drawScore();
      return;
    }
    if (this.el.finger) this.el.finger.hidden = false;
    const staff = this.el.staff;
    if (!staff) return;
    const showStaff = this.noteDisplay === 'staff' && this.staffNotes !== undefined;
    this.el.targetNote.hidden = showStaff;
    staff.hidden = !showStaff;
    // The staff already previews the following notes, so the text line would be a duplicate.
    if (this.el.upcoming) this.el.upcoming.hidden = showStaff;
    this.staffShown = showStaff;
    if (showStaff) this.drawStaff();
  }

  /**
   * Draws the staff full-bleed: as wide as the visible window (not just the
   * narrow column the rest of the page lives in), centered on that column, so
   * the notation is as large as the screen allows. Sized in pixels from the
   * window, so it is redrawn on resize.
   */
  private drawStaff(): void {
    const staff = this.el.staff;
    if (!staff || !this.staffNotes) return;
    const viewportWidth = document.documentElement.clientWidth;
    staff.style.width = `${viewportWidth}px`;
    staff.style.marginInline = `calc(50% - ${viewportWidth / 2}px)`;
    // Tall enough to read comfortably, never most of the window.
    const maxHeight = Math.min(window.innerHeight * 0.4, STAFF_MAX_HEIGHT_PX);
    // Only a mode with a "Next:" preview (ABC practice) looks ahead; Playing Practice shows just its target, centered.
    const lookahead = this.el.upcoming !== undefined;
    staff.replaceChildren(renderStaff(this.staffNotes, viewportWidth, maxHeight, lookahead));
  }

  /**
   * Shows the piece's score from the target's bar, the target highlighted. The
   * window moves (a redraw) only when the target's bar changes or the window
   * resizes; otherwise stepping to the next note is a recolour.
   */
  private drawScore(): void {
    const scoreView = this.scoreView;
    const target = this.scoreTargetIndex;
    const piece = this.piece;
    if (!scoreView || target === undefined || !piece) return;
    const element = piece.noteElements[target];
    if (!element) return;
    scoreView.show(element.bar);
    this.colourScore(target, 'due');
    scoreView.setPlayhead(undefined);
  }

  /** Target highlighted; in a normal run, the notes before it are shown as done. */
  private colourScore(target: number, targetState: 'due' | 'hit'): void {
    const drilling = this.scoreDrilling;
    this.scoreView?.applyStates((index) =>
      index === target ? targetState : !drilling && index < target ? 'hit' : 'pending',
    );
  }

  /** True while a session is in progress or on its complete screen. */
  get isActive(): boolean {
    return this.controller !== undefined;
  }

  /**
   * Starts a session over `notes` (must be non-empty) and shows the session
   * view. `piece` is the ABC piece the notes came from, for sheet-style
   * labels (and, unless `options.score` is false, real notation): normally
   * `piece.notes` are `notes`. For a *subset* of a piece (the notes a
   * play-along missed, practiced on their own) pass `{ score: false }`: the
   * labels still follow the sheet's spelling, but the staff is the plain
   * single-note one, since a score of bars the player is skipping would
   * mislead. Omit `piece` entirely for anything that is not an ABC piece.
   */
  begin(
    notes: readonly SequenceNote[],
    piece?: AbcPiece,
    options: { readonly score?: boolean; readonly fingers?: boolean } = {},
  ): void {
    this.showFingers = options.fingers === true;
    this.scoreView?.clear();
    this.scoreView = undefined;
    this.piece = undefined;
    this.scoreTargetIndex = undefined;
    this.scoreShown = false;
    if (this.el.score) this.el.score.hidden = true;
    const wantScore = options.score !== false;
    // Defensive: a score is only meaningful for exactly the notes it was built from.
    if (piece && (!wantScore || piece.notes.length === notes.length)) {
      this.piece = piece;
      if (wantScore && this.el.score) {
        this.scoreView = new ScoreView(this.el.score, piece);
        if (this.showFingers) this.scoreView.setFingers(fingerMarksOf(notes));
      }
    }
    this.notes = notes;
    this.controller = new PracticeSessionController(notes);
    this.pauseUntilMs = undefined;
    this.lastSucceededMidi = undefined;
    this.el.session.hidden = false;
    this.el.complete.hidden = true;
    this.renderCurrentState();
  }

  /** Discards the session and hides the session view (the owner decides what to show instead). */
  end(): void {
    this.controller = undefined;
    this.tracker = undefined;
    this.pauseUntilMs = undefined;
    this.lastSucceededMidi = undefined;
    this.notes = [];
    this.staffNotes = undefined;
    this.scoreView?.clear();
    this.scoreView = undefined;
    this.piece = undefined;
    this.scoreTargetIndex = undefined;
    this.scoreShown = false;
    if (this.el.score) this.el.score.hidden = true;
    this.el.session.hidden = true;
    this.el.complete.hidden = true;
  }

  /**
   * Reflects `controller.state` into the DOM and constructs a fresh
   * `PracticeAttemptTracker` for whatever target note is now active.
   * Always builds a *new* tracker here (never `reset()`s a stale one) --
   * even when Drilling's round-robin rotates back to a note whose label
   * repeats, this is a new attempt and should get a clean dwell/timeout
   * clock, not a continuation of a previous rep's.
   */
  private renderCurrentState(): void {
    if (!this.controller) return;
    const state = this.controller.state;
    this.el.successBanner.hidden = true;
    this.el.successBanner.classList.remove('pp-banner-neutral');

    if (state.mode === 'complete') {
      this.tracker = undefined;
      this.el.progress.hidden = true;
      this.el.targetRoot.hidden = true;
      this.el.complete.hidden = false;
      if (this.el.upcoming) this.el.upcoming.textContent = '';
      this.staffNotes = undefined;
      this.scoreTargetIndex = undefined;
      this.scoreShown = false;
      return;
    }

    this.el.targetRoot.hidden = false;
    this.el.complete.hidden = true;

    const isDrilling = state.mode === 'drilling';
    this.el.modeLabel.textContent = isDrilling ? 'Drilling' : '';
    this.el.progress.hidden = false;
    if (isDrilling) {
      this.el.progress.textContent = formatDrillProgress(state);
    } else {
      this.el.progress.textContent = `Note ${state.index + 1} of ${this.notes.length}`;
    }
    if (this.el.upcoming) {
      // Drilling rotates through neighbors rather than walking the piece, so a "what's next" preview would mislead there.
      const next = isDrilling
        ? []
        : this.notes.slice(state.index + 1, state.index + 1 + UPCOMING_NOTE_COUNT);
      this.el.upcoming.textContent =
        next.length > 0 ? `Next: ${next.map((n) => this.labelOf(n)).join(' ')}` : '';
    }

    this.el.targetNote.textContent = this.labelOf(state.targetNote);
    this.updateFingerLine(state.targetNote);
    // Drilling's pool is made of the sequence's own note objects, so identity finds the index.
    this.scoreDrilling = isDrilling;
    this.scoreTargetIndex = this.scoreView
      ? isDrilling
        ? this.notes.indexOf(state.targetNote)
        : state.index
      : undefined;
    if (this.scoreTargetIndex === -1) this.scoreTargetIndex = undefined;
    this.staffNotes = [
      { spelling: staffSpellingOf(state.targetNote), role: 'target' },
      ...(this.el.upcoming && !isDrilling
        ? this.notes
            .slice(state.index + 1, state.index + 1 + STAFF_LOOKAHEAD_NOTES)
            .map((n): StaffNote => ({ spelling: staffSpellingOf(n), role: 'upcoming' }))
        : []),
    ];
    this.applyNoteDisplay();

    // Live feedback + dwell progress are shared by Playing Practice and
    // Drilling. Reset on every new target regardless of mode: the fresh
    // PracticeAttemptTracker constructed below means a clean dwell/timeout
    // clock either way, so stale text/fill from the previous target must
    // not linger into this one.
    this.el.liveFeedback.textContent = '';
    this.el.dwellFill.style.width = '0%';

    // Exactly one manual escape hatch is visible at a time: Playing
    // Practice's per-attempt "give up on this note" vs. Drilling's
    // whole-drill "skip this drill".
    this.el.giveUpBtn.hidden = isDrilling;
    this.el.skipDrillBtn.hidden = !isDrilling;

    const repeatsSucceededPitch = this.lastSucceededMidi === state.targetNote.note.midi;
    this.lastSucceededMidi = undefined;
    this.tracker = new PracticeAttemptTracker(state.targetNote.frequencyHz, {
      requireReleaseFirst: repeatsSucceededPitch,
    });
  }

  private applyResult(result: PracticeAttemptStatus, timestampMs: number): void {
    if (!this.controller) return;
    // Captured once, before reportOutcome() below can change it -- used
    // both to detect a drill-ending transition and (for the success case)
    // to mirror packages/core's mastery-vs-cap tie-break.
    const stateBefore = this.controller.state;

    if (result.status === 'in-progress') {
      const fraction = Math.min(1, result.heldMs / DEFAULT_MIN_DWELL_TIME_MS);
      this.el.dwellFill.style.width = `${fraction * 100}%`;
      return;
    }

    if (result.status === 'succeeded') {
      if (stateBefore.mode !== 'complete') {
        this.lastSucceededMidi = stateBefore.targetNote.note.midi;
      }
      this.controller.reportOutcome('success');

      if (stateBefore.mode === 'drilling') {
        if (this.controller.state.mode !== 'drilling') {
          // The drill just ended on this successful rep. Failure can never
          // reach 'mastered' (see DrillingMachine.reportOutcome), but a
          // *successful* rep can still end the drill via the attempt cap
          // instead of mastery, if this rep doesn't reach
          // requiredConsecutiveCorrect -- so mastered-vs-capped isn't
          // knowable from "succeeded + drill ended" alone. Mirrors
          // packages/core's own documented tie-break ("mastery is checked
          // before the attempt cap") using only the already-public
          // consecutiveCorrect/requiredConsecutiveCorrect fields captured in
          // `stateBefore` -- a deliberate UI-layer mirror of a stable
          // contract, not a change to packages/core's public API.
          const mastered =
            stateBefore.consecutiveCorrect + 1 >= stateBefore.requiredConsecutiveCorrect;
          this.showDrillEndBanner(mastered ? 'mastered' : 'capped', timestampMs);
          return;
        }
        // Still drilling (a 'continue' outcome) -- no success flourish for
        // a single rep; the rotated target note plus the progress line's
        // counters advancing together is the visible signal.
        this.renderCurrentState();
        return;
      }

      if (this.controller.state.mode === 'complete') {
        // Go straight to the "Sequence complete!" screen rather than
        // queuing the usual "Nice!" pause below: `pauseUntilMs` is only
        // ever cleared by a *later* `handleAnalysisFrame` call (there is no
        // real setTimeout backing it), so if capture stops right as the very
        // last note succeeds, no later frame would ever arrive to reveal the
        // complete screen. The synchronous `renderCurrentState()` has no such
        // dependency.
        this.renderCurrentState();
        return;
      }
      this.el.successBanner.hidden = false;
      this.el.successBanner.textContent = 'Nice!';
      this.pauseUntilMs = timestampMs + SUCCESS_PAUSE_MS;
      // The sheet shows the note just played as done while the banner is up.
      if (this.scoreShown && this.scoreTargetIndex !== undefined) {
        this.colourScore(this.scoreTargetIndex, 'hit');
      }
      return;
    }

    // result.status === 'failed' (timeout or manual giveUp())
    this.controller.reportOutcome('failure');
    if (
      !this.drillingEnabled &&
      stateBefore.mode !== 'drilling' &&
      this.controller.state.mode === 'drilling'
    ) {
      // Drilling is switched off: a missed note is simply left behind, as if the player had skipped
      // the drill at once. (A drill already under way when the switch is turned off finishes normally.)
      this.controller.skipDrill();
      this.showDrillEndBanner('capped', timestampMs);
      return;
    }
    if (stateBefore.mode === 'drilling' && this.controller.state.mode !== 'drilling') {
      // Unlike the success path above, no inference is needed here: a
      // failure can only ever end a drill via the attempt cap, never
      // mastery -- this is unambiguously 'max-attempts-reached'.
      this.showDrillEndBanner('capped', timestampMs);
      return;
    }
    // Otherwise: either a plain Playing-Practice-level failure that just
    // *started* a new drill (state.mode is now 'drilling', so the guard
    // above correctly does not treat this as a drill *ending*) or a
    // continuing drill rep -- no special flourish either way.
    this.renderCurrentState();
  }

  /**
   * Shows the brief "Mastered!"/"Moving on" banner when a drill ends, then
   * -- exactly like the "Nice!" pause above -- hands control back after
   * SUCCESS_PAUSE_MS. Reuses `#pp-success-banner`-style element (not a
   * second, parallel banner); "Moving on" gets the neutral modifier class
   * since capping isn't a failure to punish. Mirrors the "Nice!" pause's own
   * complete-screen special case, for the identical reason.
   */
  private showDrillEndBanner(kind: 'mastered' | 'capped', timestampMs: number): void {
    if (!this.controller) return;
    if (this.controller.state.mode === 'complete') {
      this.renderCurrentState();
      return;
    }
    this.el.successBanner.hidden = false;
    this.el.successBanner.textContent = kind === 'mastered' ? 'Mastered!' : 'Moving on';
    this.el.successBanner.classList.toggle('pp-banner-neutral', kind === 'capped');
    this.pauseUntilMs = timestampMs + SUCCESS_PAUSE_MS;
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * renderer.ts's `handleAnalysis` alongside (not instead of) the Finger
   * Tuner code. A no-op whenever no session has been started yet.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    if (!this.controller) return;

    if (this.pauseUntilMs !== undefined) {
      if (timestampMs < this.pauseUntilMs) return;
      this.pauseUntilMs = undefined;
      this.renderCurrentState();
      // Fall through: score this same frame against the freshly-built
      // tracker for the new target rather than dropping it.
    }

    if (!this.tracker) return;

    // Positive check (`=== 'playing-practice' || === 'drilling'`), not
    // `!== 'complete'`: only a positive-literal check narrows
    // `state.targetNote` into scope. In practice `this.tracker` is undefined
    // whenever mode is 'complete', so the guard above already rules that out.
    const state = this.controller.state;
    if (state.mode === 'playing-practice' || state.mode === 'drilling') {
      this.el.liveFeedback.textContent = formatLiveFeedback(
        rawReading,
        state.targetNote.frequencyHz,
        this.piece,
      );
    }

    this.applyResult(this.tracker.update(reading, timestampMs), timestampMs);
  }
}
