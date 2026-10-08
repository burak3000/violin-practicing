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
 */

import {
  DEFAULT_MIN_DWELL_TIME_MS,
  PracticeAttemptTracker,
  PracticeSessionController,
  centsOffTarget,
  type FingerTunerReading,
  type PitchReading,
  type PracticeAttemptStatus,
  type PracticeSessionState,
  type SequenceNote,
} from '@violin/core';

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
}

/** Mirrors renderer.ts's own `formatCents` (note.ts's `describeFrequency` sign convention) -- small enough that a shared export isn't worth the cross-file coupling. */
function formatSignedCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/** What to show on the live "what am I currently hearing" line -- cents measured from the *target* (centsOffTarget), not from the nearest note in general, so the sign directly tells the player which way to adjust. */
function formatLiveFeedback(rawReading: FingerTunerReading, targetFrequencyHz: number): string {
  if (rawReading.status === 'no-signal') return 'No signal';
  if (rawReading.status === 'unclear') return 'Unclear signal…';
  const cents = centsOffTarget(rawReading.frequencyHz, targetFrequencyHz);
  return `Hearing ${rawReading.note.label} (${formatSignedCents(cents)} from target)`;
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
  }

  /** True while a session is in progress or on its complete screen. */
  get isActive(): boolean {
    return this.controller !== undefined;
  }

  /** Starts a session over `notes` (must be non-empty) and shows the session view. */
  begin(notes: readonly SequenceNote[]): void {
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
        next.length > 0 ? `Next: ${next.map((n) => n.note.label).join(' ')}` : '';
    }

    this.el.targetNote.textContent = state.targetNote.note.label;

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
      return;
    }

    // result.status === 'failed' (timeout or manual giveUp())
    this.controller.reportOutcome('failure');
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
      );
    }

    this.applyResult(this.tracker.update(reading, timestampMs), timestampMs);
  }
}
