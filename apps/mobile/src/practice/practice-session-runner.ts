/**
 * The shared "run one practice session" half of mobile Playing Practice,
 * extracted from `PlayingPracticeController` so ABC Notation practice
 * (`abc-practice-controller.ts`) drives the exact same session logic with an
 * ABC-derived note sequence instead of a generated one -- the mobile
 * counterpart of `apps/desktop/src/practice-session-view.ts`. Given a
 * sequence it owns the `PracticeSessionController` (Playing Practice <->
 * Drilling hand-off), one `PracticeAttemptTracker` per target note, the pause
 * after a banner, and the plain `PlayingPracticeSessionViewState` snapshot a
 * presentational React component renders.
 *
 * Zero react/react-native imports, independently unit-testable (see the
 * controllers' test files, which exercise it through their public APIs).
 * Everything about *why* the session behaves as it does (Drilling reuse of
 * the live-feedback line and dwell bar, the mastered-vs-capped inference, no
 * per-drill-note role label, `giveUp()` using `performance.now()`) is carried
 * over unchanged from Phase 6/7 and documented in `apps/mobile/CLAUDE.md`'s
 * "Phase 6 Part B" / "Phase 7 Part B" sections; the comments here keep the
 * "why" next to the code that depends on it.
 *
 * ## Repeated pitches (new with ABC)
 *
 * A tune can ask for the same pitch twice in a row; a player still holding
 * the note they just got credit for would otherwise satisfy the next,
 * identical target immediately. When an attempt *succeeds* and the next
 * target has the same pitch, the next tracker is built with
 * `requireReleaseFirst` -- the player must leave the pitch (a gap, a bow
 * change, another note) before the dwell clock starts. See
 * `PracticeAttemptTracker`. It deliberately does not apply after a *failed*
 * attempt (Drilling reopens on the same note, and nothing was credited that a
 * held note could leak into). Generated scale sequences never repeat a pitch
 * back to back after a success, so Playing Practice's behavior is unchanged.
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
 * `performance.now()` timestamp domain every hop in this pipeline already
 * uses -- see App.tsx's `onAnalysis` callback) before advancing to the next
 * target. Matches apps/desktop/src/practice-session-view.ts's own
 * `SUCCESS_PAUSE_MS` exactly, for the same "reads as the same product on
 * both platforms" reason -- a UI-timing constant, not a domain/scoring
 * concern, so it's kept here rather than in packages/core.
 */
const SUCCESS_PAUSE_MS = 700;

/** How many upcoming notes the optional "Next:" line previews. */
const UPCOMING_NOTE_COUNT = 4;

/**
 * The brief post-attempt banner Playing Practice/Drilling show before
 * advancing: "Nice!" (a non-final Playing Practice success), "Mastered!" (a
 * drill ending via `requiredConsecutiveCorrect`), or "Moving on" (a drill
 * ending via `maxAttempts`) -- `tone: 'neutral'` only for the last of these,
 * since capping isn't a failure to punish. A manual `skipDrill()` or
 * `giveUp()` never produces one, matching this codebase's established
 * no-flourish convention for a deliberate user action.
 */
export interface PlayingPracticeBanner {
  readonly text: string;
  readonly tone: 'success' | 'neutral';
}

/**
 * What the session view should show right now. `'active'` covers both
 * Playing Practice and Drilling (distinguished by `mode`); the only
 * mode-dependent differences are which of `showGiveUpButton`/
 * `showSkipDrillButton` is true and what `progressText` says.
 */
export type PlayingPracticeSessionViewState =
  | {
      readonly kind: 'active';
      readonly mode: 'playing-practice' | 'drilling';
      /** e.g. "Note 3 of 12", or, while drilling, "Drilling: 1 of 3 correct in a row · attempt 2 of 12" (see `formatDrillProgress()`). */
      readonly progressText: string;
      readonly targetNoteLabel: string;
      /** e.g. "Hearing A4 (+8c from target)" / "No signal". */
      readonly liveFeedbackText: string;
      /** 0..1, how far toward the dwell-time threshold the current in-tune hold has progressed. */
      readonly dwellFraction: number;
      /** Playing Practice's own per-attempt "give up on this note" -- mutually exclusive with `showSkipDrillButton` (exactly one is ever true for an active session). */
      readonly showGiveUpButton: boolean;
      /** Drilling's whole-drill "skip this drill" -- mutually exclusive with `showGiveUpButton`. */
      readonly showSkipDrillButton: boolean;
      readonly banner: PlayingPracticeBanner | undefined;
      /**
       * "Next: B4 C5 D5 E5" -- only set for runners created with
       * `showUpcoming` (ABC practice, where seeing what's coming is part of
       * reading a sheet), and empty while drilling.
       */
      readonly upcomingText?: string;
    }
  | { readonly kind: 'complete' };

/**
 * Mirrors apps/desktop's own local `formatSignedCents` -- deliberately
 * duplicated rather than imported from `../tuner/tuner-view-model.ts`'s
 * `formatCents` (same sign-of-the-rounded-value convention, same output
 * shape): small enough that a shared export isn't worth the cross-file
 * coupling, and it keeps this module independent of `../tuner/*`.
 */
function formatSignedCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/** What to show on the live "what am I currently hearing" line -- cents measured from the *target* (`centsOffTarget`), not from the nearest note in general, so the sign directly tells the player which way to adjust. */
function formatLiveFeedback(rawReading: FingerTunerReading, targetFrequencyHz: number): string {
  if (rawReading.status === 'no-signal') return 'No signal';
  if (rawReading.status === 'unclear') return 'Unclear signal…';
  const cents = centsOffTarget(rawReading.frequencyHz, targetFrequencyHz);
  return `Hearing ${rawReading.note.label} (${formatSignedCents(cents)} from target)`;
}

/**
 * "Drilling: N of M correct in a row · attempt A of B". `attemptsUsed` counts
 * *completed* attempts (`DrillingMachine.reportOutcome` increments it before
 * deciding the outcome -- see packages/core), so the attempt currently in
 * progress is `attemptsUsed + 1`: 1-indexed for a human-friendly "attempt 1
 * of 12" on the very first rep rather than "attempt 0 of 12".
 */
function formatDrillProgress(state: Extract<PracticeSessionState, { mode: 'drilling' }>): string {
  return `Drilling: ${state.consecutiveCorrect} of ${state.requiredConsecutiveCorrect} correct in a row · attempt ${
    state.attemptsUsed + 1
  } of ${state.maxAttempts}`;
}

export interface PracticeSessionRunnerOptions {
  /** Called after every change to the session's view state. */
  readonly onChange: () => void;
  /** Show a "Next: ..." preview of the following notes (ABC practice). Default false. */
  readonly showUpcoming?: boolean;
}

export class PracticeSessionRunner {
  private notes: readonly SequenceNote[] = [];
  private sessionController: PracticeSessionController | undefined;
  private tracker: PracticeAttemptTracker | undefined;
  /** MIDI number of the target whose attempt just succeeded, until the next target is rendered -- see the "Repeated pitches" note in the module doc comment. */
  private lastSucceededMidi: number | undefined;
  /** Set while a banner ("Nice!"/"Mastered!"/"Moving on") is showing; `handleAnalysisFrame` ignores frames until this timestamp is reached, then advances. */
  private pauseUntilMs: number | undefined;
  private currentBanner: PlayingPracticeBanner | undefined;
  private liveFeedbackText = '';
  private dwellFraction = 0;

  // `currentMode`/`currentProgressText`/`currentTargetNoteLabel`/
  // `currentUpcomingText` are a deliberate cache, NOT a live re-derivation
  // from `sessionController.state` on every `getView()` call -- and that
  // distinction matters for one specific, easy-to-get-wrong case: while a
  // banner is showing (`currentBanner` set, mid-pause --
  // "Nice!"/"Mastered!"/"Moving on"), `sessionController.state` has
  // *already* internally advanced (`reportOutcome(...)` runs immediately in
  // `applyResult`, before the pause even starts) -- but the display must
  // keep showing the just-finished attempt's mode/note next to the banner
  // until `renderCurrentState()` actually runs again after the pause
  // elapses. Written only by `renderCurrentState()`, read (not re-derived)
  // by `getView()`. Placeholder initial values are never observed: `getView()`
  // only reports 'active' after `begin()`, which always calls
  // `renderCurrentState()` first.
  private currentMode: 'playing-practice' | 'drilling' = 'playing-practice';
  private currentProgressText = '';
  private currentTargetNoteLabel = '';
  private currentUpcomingText = '';

  private readonly onChange: () => void;
  private readonly showUpcoming: boolean;

  constructor(options: PracticeSessionRunnerOptions) {
    this.onChange = options.onChange;
    this.showUpcoming = options.showUpcoming ?? false;
  }

  /** True from `begin()` until `end()` (including the complete screen). */
  get isActive(): boolean {
    return this.sessionController !== undefined;
  }

  /** The current session snapshot, or `undefined` if no session is active. */
  getView(): PlayingPracticeSessionViewState | undefined {
    if (!this.sessionController) return undefined;

    // `state.mode === 'complete'` is checked directly against the live
    // session (not the cache) -- a sequence-completing success is always
    // rendered immediately (see applyResult()'s "straight to complete"
    // branch), so there is no pause-related staleness to guard against here.
    if (this.sessionController.state.mode === 'complete') {
      return { kind: 'complete' };
    }

    const isDrilling = this.currentMode === 'drilling';
    return {
      kind: 'active',
      mode: this.currentMode,
      progressText: this.currentProgressText,
      targetNoteLabel: this.currentTargetNoteLabel,
      liveFeedbackText: this.liveFeedbackText,
      dwellFraction: this.dwellFraction,
      showGiveUpButton: !isDrilling,
      showSkipDrillButton: isDrilling,
      banner: this.currentBanner,
      ...(this.showUpcoming ? { upcomingText: this.currentUpcomingText } : {}),
    };
  }

  /** Starts a session over `notes` (must be non-empty). */
  begin(notes: readonly SequenceNote[]): void {
    this.notes = notes;
    this.sessionController = new PracticeSessionController(notes);
    this.pauseUntilMs = undefined;
    this.lastSucceededMidi = undefined;
    this.renderCurrentState();
  }

  /** Discards the session. Does not notify: the owner decides what to show next and emits itself. */
  end(): void {
    this.sessionController = undefined;
    this.tracker = undefined;
    this.pauseUntilMs = undefined;
    this.lastSucceededMidi = undefined;
    this.currentBanner = undefined;
    this.notes = [];
  }

  /**
   * "Having trouble? Skip this note" -- see `packages/core`'s
   * `PracticeAttemptTracker.giveUp()`. A no-op if no attempt is currently
   * in progress (no session started yet, or the current attempt is
   * already decided).
   *
   * Uses `performance.now()` -- the same timestamp domain
   * `handleAnalysisFrame` is fed -- because a failure that ends a drill via
   * the attempt cap schedules a banner pause (`showDrillEndBanner`, via
   * `pauseUntilMs`) that later hops' timestamps are compared against; mixing
   * in `Date.now()` (epoch-scale) would make that pause permanently
   * unreachable and strand the banner. Not currently reachable through this
   * app's own UI (the give-up button is hidden while drilling), but fixed at
   * the source rather than left as a latent trap.
   */
  giveUp(): void {
    if (!this.tracker) return;
    this.applyResult(this.tracker.giveUp(), performance.now());
  }

  /**
   * "Skip this drill" -- bypasses `PracticeAttemptTracker` entirely (unlike
   * `giveUp()` above), abandoning the whole drill immediately via
   * `PracticeSessionController.skipDrill()` (-> `DrillingMachine.skip()`),
   * not just the current rep. A no-op if not currently drilling. Renders
   * immediately with no banner/pause -- a manual skip is already its own
   * signal.
   */
  skipDrill(): void {
    if (!this.sessionController || this.sessionController.state.mode !== 'drilling') return;
    this.sessionController.skipDrill();
    this.renderCurrentState();
  }

  /**
   * Reflects `sessionController.state` into the cached display fields and
   * constructs a fresh `PracticeAttemptTracker` for whatever target note is
   * now active. Always builds a *new* tracker here (never `reset()`s a stale
   * one) -- even when Drilling's round-robin rotates back to a note whose
   * label repeats, this is a new attempt and should get a clean dwell/timeout
   * clock, not a continuation of a previous rep's.
   */
  private renderCurrentState(): void {
    if (!this.sessionController) return;
    this.currentBanner = undefined;
    const state = this.sessionController.state;

    if (state.mode === 'complete') {
      this.tracker = undefined;
      this.onChange();
      return;
    }

    const isDrilling = state.mode === 'drilling';
    this.currentMode = isDrilling ? 'drilling' : 'playing-practice';
    this.currentProgressText = isDrilling
      ? formatDrillProgress(state)
      : `Note ${state.index + 1} of ${this.notes.length}`;
    // Drilling rotates through neighbors rather than walking the piece, so a
    // "what's next" preview would mislead there.
    const next = isDrilling
      ? []
      : this.notes.slice(state.index + 1, state.index + 1 + UPCOMING_NOTE_COUNT);
    this.currentUpcomingText =
      next.length > 0 ? `Next: ${next.map((n) => n.note.label).join(' ')}` : '';
    this.currentTargetNoteLabel = state.targetNote.note.label;

    // Live feedback + dwell progress are shared by Playing Practice and
    // Drilling. Reset on every new target regardless of mode: the fresh
    // tracker below means a clean dwell/timeout clock either way, so stale
    // text/fill from the previous target must not linger into this one.
    this.liveFeedbackText = '';
    this.dwellFraction = 0;

    const repeatsSucceededPitch = this.lastSucceededMidi === state.targetNote.note.midi;
    this.lastSucceededMidi = undefined;
    this.tracker = new PracticeAttemptTracker(state.targetNote.frequencyHz, {
      requireReleaseFirst: repeatsSucceededPitch,
    });
    this.onChange();
  }

  private applyResult(result: PracticeAttemptStatus, timestampMs: number): void {
    if (!this.sessionController) return;
    // Captured once, before reportOutcome() below can change it -- used
    // both to detect a drill-ending transition and (for the success case)
    // to mirror packages/core's mastery-vs-cap tie-break.
    const stateBefore = this.sessionController.state;

    if (result.status === 'in-progress') {
      this.dwellFraction = Math.min(1, result.heldMs / DEFAULT_MIN_DWELL_TIME_MS);
      this.onChange();
      return;
    }

    if (result.status === 'succeeded') {
      if (stateBefore.mode !== 'complete') {
        this.lastSucceededMidi = stateBefore.targetNote.note.midi;
      }
      this.sessionController.reportOutcome('success');

      if (stateBefore.mode === 'drilling') {
        if (this.sessionController.state.mode !== 'drilling') {
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
        // Still drilling (a 'continue' outcome) -- no success flourish for a
        // single rep; the rotated target note plus the progress line's
        // counters advancing together is the visible signal.
        this.renderCurrentState();
        return;
      }

      if (this.sessionController.state.mode === 'complete') {
        // Go straight to the "complete" screen rather than queuing the usual
        // "Nice!" pause: `pauseUntilMs` is only ever cleared by a *later*
        // `handleAnalysisFrame` call (there is no real setTimeout backing
        // it), so if capture stops right as the very last note succeeds, no
        // later frame would ever arrive to reveal the complete screen. The
        // synchronous `renderCurrentState()` has no such dependency.
        this.renderCurrentState();
        return;
      }
      this.currentBanner = { text: 'Nice!', tone: 'success' };
      this.pauseUntilMs = timestampMs + SUCCESS_PAUSE_MS;
      this.onChange();
      return;
    }

    // result.status === 'failed' (timeout or manual giveUp())
    this.sessionController.reportOutcome('failure');
    if (stateBefore.mode === 'drilling' && this.sessionController.state.mode !== 'drilling') {
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
   * -- exactly like the "Nice!" pause -- hands control back after
   * `SUCCESS_PAUSE_MS`. Mirrors the "Nice!" pause's own complete-screen
   * special case, for the identical reason.
   */
  private showDrillEndBanner(kind: 'mastered' | 'capped', timestampMs: number): void {
    if (!this.sessionController) return;
    if (this.sessionController.state.mode === 'complete') {
      this.renderCurrentState();
      return;
    }
    this.currentBanner =
      kind === 'mastered'
        ? { text: 'Mastered!', tone: 'success' }
        : { text: 'Moving on', tone: 'neutral' };
    this.pauseUntilMs = timestampMs + SUCCESS_PAUSE_MS;
    this.onChange();
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * App.tsx's `onAnalysis` callback alongside (not instead of) the existing
   * Finger Tuner code. A no-op whenever no session has been started yet.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    if (!this.sessionController) return;

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
    const state = this.sessionController.state;
    if (state.mode === 'playing-practice' || state.mode === 'drilling') {
      this.liveFeedbackText = formatLiveFeedback(rawReading, state.targetNote.frequencyHz);
    }

    this.applyResult(this.tracker.update(reading, timestampMs), timestampMs);
  }
}
