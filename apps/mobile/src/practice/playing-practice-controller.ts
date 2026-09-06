/**
 * Phase 6 Part B: the headless (React-Native-import-free) controller behind
 * the mobile Playing Practice mode -- the RN analogue of
 * apps/desktop/src/playing-practice-ui.ts's `PlayingPracticeUi`, fed by the
 * exact same Phase 4 capture -> DSP pipeline as Finger Tuner (see
 * apps/mobile/App.tsx) -- but through `packages/core`'s
 * `PracticeAttemptTracker`, not `analyzeTunerReading`'s raw output and NOT
 * `TunerDisplaySmoother` (that class is for continuous tuner display; this
 * is discrete, single-note, dwell-and-give-up scoring against a specific
 * target -- a different job, see `packages/core/CLAUDE.md`'s "Session
 * state machines" section).
 *
 * Unlike desktop's `PlayingPracticeUi` (which mutates DOM elements
 * directly), this class has no rendering surface of its own: it computes a
 * plain `PlayingPracticeViewState` snapshot and pushes it to
 * `events.onChange` whenever it changes, for a presentational React
 * component (`./PlayingPracticeScreen.tsx`) to render. This mirrors this
 * app's own established split between headless logic and presentation --
 * see `../audio/mic-capture-controller.ts` (event-callback controller) and
 * `../tuner/tuner-view-model.ts` (pure view-model derivation), and is
 * itself zero react/react-native imports, independently unit-testable
 * exactly like those modules (see the co-located test file).
 *
 * ## Integration point: PracticeSessionController, not the bare
 * PlayingPracticeMachine
 *
 * `packages/core`'s `PracticeSessionController` already composes
 * `PlayingPracticeMachine` + `DrillingMachine` into "the single state
 * machine a UI actually drives" (its own doc comment) -- wiring that in now
 * (exactly as apps/desktop's Phase 6 Part A already did) means Phase 7
 * (real Drilling UI, both platforms) only has to change what this file (and
 * PlayingPracticeScreen.tsx) render for `state.mode === 'drilling'`, not
 * replace the integration itself.
 *
 * ## Drilling UI (Phase 7 Part B) -- real, not a placeholder anymore
 *
 * Phase 6 Part B deliberately left `sessionController.state.mode ===
 * 'drilling'` as a minimal, honest placeholder (see this file's git history
 * or `apps/mobile/CLAUDE.md`'s "Phase 6 Part B" section for exactly what
 * that looked like). This phase replaces it with a real Drilling UI,
 * mirroring `apps/desktop/src/playing-practice-ui.ts`'s own Phase 7 design
 * "in substance, not in code" -- same reused chrome, same two judgment
 * calls (see below), same mastered-vs-capped inference -- ported to this
 * file's headless view-state shape rather than DOM mutation.
 * `DrillingMachine`/`PracticeSessionController` themselves (packages/core,
 * Phase 2) are untouched; this is UI wiring on top of already-implemented,
 * already-tested domain logic, per this phase's scope.
 *
 * **Reused, not re-derived, from Playing Practice's own attempt scoring:**
 * `liveFeedbackText` and `dwellFraction` are populated identically whether
 * `sessionController.state.mode` is `'playing-practice'` or `'drilling'` --
 * see `renderCurrentState()` (no longer resets them to blank/zero only for
 * non-drilling) and `handleAnalysisFrame()` (no longer restricts the
 * live-feedback update to `'playing-practice'` alone). A drilling rep gets
 * the identical "am I close, how long have I held it" feedback a normal
 * target-note attempt gets, from the same code path, not a parallel copy.
 *
 * **Progress line**: `progressText` is populated for `'drilling'` too, via
 * `formatDrillProgress()` -- "Drilling: _N_ of _M_ correct in a row ·
 * attempt _A_ of _B_" from `consecutiveCorrect`/`requiredConsecutiveCorrect`/
 * `attemptsUsed`/`maxAttempts` (all already implemented/tested in
 * `packages/core` since Phase 2) -- rather than a second, parallel field.
 *
 * **Which pool note is active, as the pool rotates**: a documented judgment
 * call carried over unchanged from apps/desktop's Phase 7 Part A, not
 * re-decided here -- `DrillPoolNote.role` (`'neighbor-below' | 'center' |
 * 'neighbor-above'`) is NOT surfaced anywhere in this view state.
 * `PracticeSessionController.state`'s `'drilling'` variant only exposes
 * `targetNote: SequenceNote` (no `role`), by design -- see
 * `packages/core/src/practice/practice-session-controller.ts`. Widening
 * that public shape would be small and additive, but it's still a
 * modification to a composed, already-tested `packages/core` state
 * machine, which this phase's own instructions say to avoid without
 * flagging first -- and explicitly offer "just rely on the note name
 * changing" as an equally acceptable alternative, which is what's
 * implemented: `targetNoteLabel` and `progressText`'s counters always
 * change together in the same `renderCurrentState()` call.
 *
 * **`skipDrill()`**: wires `PracticeSessionController.skipDrill()` (->
 * `DrillingMachine.skip()`) directly -- it does NOT go through
 * `PracticeAttemptTracker`, unlike `giveUp()`, because it is a different,
 * stronger action (abandon the whole drill immediately, regardless of
 * progress) than giving up on just the current rep. `showGiveUpButton` and
 * `showSkipDrillButton` are mutually exclusive, mirroring
 * apps/desktop's `#pp-giveup-btn`/`#pp-skip-drill-btn` pair exactly --
 * deliberately not offering a *second*, per-rep give-up affordance during
 * drilling beyond what this phase's scope asks for (the automatic
 * `PracticeAttemptTracker` timeout still recovers a single stuck rep on its
 * own).
 *
 * **Mastered-vs-capped inference, not a `packages/core` API change** --
 * carried over unchanged from apps/desktop's identical Phase 7 Part A
 * judgment call. `PracticeSessionController.reportOutcome()`/`skipDrill()`
 * both return `void`, so this file cannot directly observe *which* of
 * Drilling's three terminal outcomes just fired. A drill-ending *failure*
 * is unambiguous (`DrillingMachine.reportOutcome` can never reach
 * `'mastered'` on a failure), but a drill-ending *success* could be either
 * mastery or a cap-on-a-success, so `applyResult()` mirrors `packages/core`'s
 * own documented tie-break ("mastery is checked before the attempt cap" --
 * see `drilling.ts`'s and `practice-session-controller.ts`'s doc comments)
 * using only the already-public `consecutiveCorrect`/
 * `requiredConsecutiveCorrect` fields captured in `stateBefore` just before
 * calling `reportOutcome`. This is a one-line mirror of a stable, documented
 * contract, not a re-implementation of undocumented internals -- but it
 * would need updating if that tie-break rule ever changes. Manual
 * `skipDrill()` clicks get no banner at all (mirrors Playing Practice's own
 * manual give-up, which also gets no flourish) -- an intentional user
 * action is already its own signal.
 */

import {
  DEFAULT_MIN_DWELL_TIME_MS,
  DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ,
  DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ,
  PracticeAttemptTracker,
  PracticeSessionController,
  VIOLIN_STRING_ORDER,
  centsOffTarget,
  generatePlayingPracticeSequence,
  type FingerTunerReading,
  type PitchReading,
  type PracticeAttemptStatus,
  type PracticeSessionState,
  type SequenceDirection,
  type SequenceGeneratorConfig,
  type SequenceNote,
  type SequencePatternType,
  type ViolinStringName,
} from '@violin/core';

/**
 * How long the "Nice!" success banner stays up (measured in the same
 * `performance.now()` timestamp domain every hop in this pipeline already
 * uses -- see App.tsx's `onAnalysis` callback) before advancing to the next
 * target. Matches apps/desktop/src/playing-practice-ui.ts's own
 * `SUCCESS_PAUSE_MS` exactly, for the same "reads as the same product on
 * both platforms" reason -- a UI-timing constant, not a domain/scoring
 * concern, so it's kept here rather than in packages/core.
 */
const SUCCESS_PAUSE_MS = 700;

/** One checkbox-equivalent per violin string, keyed for direct use as `SequenceGeneratorConfig.strings` (via `VIOLIN_STRING_ORDER.filter`). */
export type StringSelection = Readonly<Record<ViolinStringName, boolean>>;

const ALL_STRINGS_SELECTED: StringSelection = { G: true, D: true, A: true, E: true };

export interface PlayingPracticeConfigSnapshot {
  readonly strings: StringSelection;
  readonly patternType: SequencePatternType;
  readonly direction: SequenceDirection;
  /**
   * Raw text-field contents, not parsed numbers -- mirrors an HTML
   * `<input type="number">`'s own `.value` being a string, so a
   * `TextInput` can hold exactly what the user typed (including a
   * momentarily-empty field while editing) without this controller
   * fighting the field's cursor/selection state. Parsed via `Number(...)`
   * only when actually generating a sequence (`readConfig()`) -- see that
   * method's own comment for how a non-numeric value is handled (never a
   * thrown exception).
   */
  readonly minFrequencyText: string;
  readonly maxFrequencyText: string;
}

/**
 * The live "what would Start produce right now" preview -- directly
 * mirrors apps/desktop/src/playing-practice-ui.ts's `updatePreview()`
 * three-way outcome (a real, non-empty sequence; a structurally valid but
 * unproductive config; or a thrown `RangeError`) so
 * "changing the sequence config visibly changes what the generator
 * produces" is true even before pressing Start -- see this file's own
 * `computePreview()`.
 */
export type PlayingPracticePreview =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'empty'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

/**
 * The brief post-attempt banner Playing Practice/Drilling show before
 * advancing: "Nice!" (a non-final Playing Practice success), "Mastered!" (a
 * drill ending via `requiredConsecutiveCorrect`), or "Moving on" (a drill
 * ending via `maxAttempts`) -- `tone: 'neutral'` only for the last of these,
 * since capping isn't a failure to punish (mirrors apps/desktop's
 * `.pp-banner-neutral` modifier; see PlayingPracticeScreen.tsx's
 * `successBannerNeutral` style, which reuses this app's existing
 * active-chip/segment/mode-tab blue rather than inventing a new hue, same
 * as desktop's own comment on that color choice). The session's `banner`
 * field is `undefined` when no banner should show -- a manual `skipDrill()`
 * or `giveUp()` never produces one, matching this codebase's established
 * no-flourish convention for a deliberate user action.
 */
export interface PlayingPracticeBanner {
  readonly text: string;
  readonly tone: 'success' | 'neutral';
}

/**
 * What the session view should show right now. `'active'` covers both
 * Playing Practice and Drilling (distinguished by `mode`) -- as of Phase 7
 * Part B, Drilling reuses every field here identically to Playing Practice
 * (see the module doc comment's "Drilling UI (Phase 7 Part B)" section);
 * the only mode-dependent differences left are which of
 * `showGiveUpButton`/`showSkipDrillButton` is true and what `progressText`
 * says.
 */
export type PlayingPracticeSessionViewState =
  | {
      readonly kind: 'active';
      readonly mode: 'playing-practice' | 'drilling';
      /** e.g. "Note 3 of 12", or, while drilling, "Drilling: 1 of 3 correct in a row · attempt 2 of 12" (see `formatDrillProgress()`). */
      readonly progressText: string;
      readonly targetNoteLabel: string;
      /** e.g. "Hearing A4 (+8c from target)" / "No signal" -- populated identically for `'drilling'` as of Phase 7 (previously `undefined` then). */
      readonly liveFeedbackText: string;
      /** 0..1, how far toward the dwell-time threshold the current in-tune hold has progressed -- populated identically for `'drilling'` as of Phase 7 (previously `undefined` then). */
      readonly dwellFraction: number;
      /** Playing Practice's own per-attempt "give up on this note" -- mutually exclusive with `showSkipDrillButton` (exactly one is ever true for an active session). */
      readonly showGiveUpButton: boolean;
      /** Drilling's whole-drill "skip this drill" (Phase 7) -- mutually exclusive with `showGiveUpButton`. */
      readonly showSkipDrillButton: boolean;
      readonly banner: PlayingPracticeBanner | undefined;
    }
  | { readonly kind: 'complete' };

export type PlayingPracticeViewState =
  | {
      readonly phase: 'config';
      readonly config: PlayingPracticeConfigSnapshot;
      readonly preview: PlayingPracticePreview;
      /** Set only after `start()` is called with a config that fails to produce a session (structurally invalid, or valid-but-empty) -- distinct from `preview`, mirroring apps/desktop's separate `pp-preview`/`pp-config-error` elements. */
      readonly configError: string | undefined;
    }
  | { readonly phase: 'session'; readonly session: PlayingPracticeSessionViewState };

export interface PlayingPracticeControllerEvents {
  readonly onChange?: (state: PlayingPracticeViewState) => void;
}

/**
 * Mirrors apps/desktop/src/playing-practice-ui.ts's own local
 * `formatSignedCents` -- deliberately duplicated rather than imported from
 * `../tuner/tuner-view-model.ts`'s `formatCents` (same sign-of-the-rounded-
 * value convention, same output shape), matching that desktop module's own
 * documented precedent: "small enough that a shared export isn't worth the
 * cross-file coupling." Also keeps this module fully independent of
 * `../tuner/*` (a different mode's code this phase is explicitly not meant
 * to touch or depend on).
 */
function formatSignedCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/** What to show on the live "what am I currently hearing" line -- cents measured from the *target* (`centsOffTarget`), not from the nearest note in general, so the sign directly tells the player which way to adjust. Verbatim-ported logic from apps/desktop/src/playing-practice-ui.ts's `formatLiveFeedback`. */
function formatLiveFeedback(rawReading: FingerTunerReading, targetFrequencyHz: number): string {
  if (rawReading.status === 'no-signal') return 'No signal';
  if (rawReading.status === 'unclear') return 'Unclear signal…';
  const cents = centsOffTarget(rawReading.frequencyHz, targetFrequencyHz);
  return `Hearing ${rawReading.note.label} (${formatSignedCents(cents)} from target)`;
}

/**
 * "Drilling: N of M correct in a row · attempt A of B" -- reuses the same
 * `progressText` slot Playing Practice's own "Note X of Y" uses (see
 * `renderCurrentState()`), not a second, parallel field. `attemptsUsed`
 * counts *completed* attempts (`DrillingMachine.reportOutcome` increments it
 * before deciding the outcome -- see packages/core), so the attempt
 * currently in progress is `attemptsUsed + 1`: 1-indexed for a
 * human-friendly "attempt 1 of 12" on the very first rep rather than
 * "attempt 0 of 12". Verbatim port of
 * apps/desktop/src/playing-practice-ui.ts's own `formatDrillProgress()`.
 */
function formatDrillProgress(state: Extract<PracticeSessionState, { mode: 'drilling' }>): string {
  return `Drilling: ${state.consecutiveCorrect} of ${state.requiredConsecutiveCorrect} correct in a row · attempt ${
    state.attemptsUsed + 1
  } of ${state.maxAttempts}`;
}

/**
 * Owns the mobile Playing Practice mode's whole lifecycle: the current
 * sequence-configuration controls, generating the sequence, driving a
 * `PracticeSessionController`, and scoring each live hop through a fresh
 * `PracticeAttemptTracker` per target note. One instance for the app's
 * lifetime (mirrors `MicCaptureController`'s own "one instance, event-
 * callback" shape) -- constructed once in App.tsx and fed every analysis
 * hop via `handleAnalysisFrame`, regardless of which mode tab is currently
 * visible (see apps/desktop/CLAUDE.md's "Mode switcher" section for why:
 * switching back to this tab should not have lost its place in the
 * sequence, and there's no reason to run two separate audio pipelines for
 * one microphone -- App.tsx keeps both this controller and Finger Tuner's
 * own state fed from the same single `onAnalysis` callback).
 */
export class PlayingPracticeController {
  // --- Config state (config phase only, but harmless to mutate anytime) --
  private stringsSelected: StringSelection = ALL_STRINGS_SELECTED;
  private patternType: SequencePatternType = 'stepwise-first-position';
  private direction: SequenceDirection = 'ascending';
  private minFrequencyText: string = String(DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ);
  private maxFrequencyText: string = String(DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ);
  private configErrorText: string | undefined;

  // --- Session state ---------------------------------------------------
  private notes: readonly SequenceNote[] = [];
  private sessionController: PracticeSessionController | undefined;
  private tracker: PracticeAttemptTracker | undefined;
  /** Set while a banner ("Nice!"/"Mastered!"/"Moving on") is showing; `handleAnalysisFrame` ignores frames until this timestamp is reached, then advances. */
  private pauseUntilMs: number | undefined;
  private currentBanner: PlayingPracticeBanner | undefined;
  private liveFeedbackText = '';
  private dwellFraction = 0;

  // `currentMode`/`currentProgressText`/`currentTargetNoteLabel` are a
  // deliberate cache, NOT a live re-derivation from
  // `sessionController.state` on every `computeViewState()` call -- and
  // that distinction matters for one specific, easy-to-get-wrong case:
  // while a banner is showing (`currentBanner` set, mid-pause --
  // "Nice!"/"Mastered!"/"Moving on"), `sessionController.state` has
  // *already* internally advanced (`reportOutcome(...)` runs immediately in
  // `applyResult`, before the pause even starts) -- but the display must
  // keep showing the just-finished attempt's mode/note next to the banner
  // until `renderCurrentState()` actually runs again after the pause
  // elapses. apps/desktop/src/playing-practice-ui.ts gets this for free:
  // its `applyResult()`/`showDrillEndBanner()` simply don't touch
  // `#pp-target-note`'s DOM text during the pause branches, so the stale
  // text stays on screen by omission. This class has no DOM to "just not
  // touch," so the fields below are the explicit equivalent -- written only
  // by `renderCurrentState()`, read (not re-derived) by `computeViewState()`.
  // Placeholder initial values, never actually observed: the 'active'
  // branch of `computeViewState()` is only reachable after `start()`,
  // which always calls `renderCurrentState()` at least once first.
  private currentMode: 'playing-practice' | 'drilling' = 'playing-practice';
  private currentProgressText = '';
  private currentTargetNoteLabel = '';

  constructor(private readonly events: PlayingPracticeControllerEvents = {}) {}

  /**
   * Current snapshot, computed fresh from live fields -- safe to call any
   * time, including as a React `useState` lazy initializer (see
   * `INITIAL_PLAYING_PRACTICE_VIEW_STATE` below and App.tsx). Deliberately
   * NOT pushed via `events.onChange` from the constructor itself (mirrors
   * `MicCaptureController`'s own convention of never synchronously
   * reporting state during construction) -- a caller that needs the
   * starting state reads it directly via this method instead.
   */
  getViewState(): PlayingPracticeViewState {
    return this.computeViewState();
  }

  private emit(): void {
    this.events.onChange?.(this.computeViewState());
  }

  private readConfig(): SequenceGeneratorConfig {
    return {
      strings: VIOLIN_STRING_ORDER.filter((name) => this.stringsSelected[name]),
      patternType: this.patternType,
      direction: this.direction,
      // `Number('')` is 0 and `Number('not a number')` is NaN -- neither
      // throws here. A structurally-empty-or-garbage range just resolves
      // to `generatePlayingPracticeSequence` either throwing (min > max,
      // handled below) or filtering out every note (NaN comparisons are
      // always false, so a NaN bound also produces an empty sequence) --
      // both are already-handled outcomes, see computePreview()/start().
      minFrequencyHz: Number(this.minFrequencyText),
      maxFrequencyHz: Number(this.maxFrequencyText),
    };
  }

  private computePreview(): PlayingPracticePreview {
    let notes: readonly SequenceNote[];
    try {
      notes = generatePlayingPracticeSequence(this.readConfig());
    } catch (err) {
      return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    }
    if (notes.length === 0) {
      return { kind: 'empty', text: '0 notes — this configuration produces an empty sequence.' };
    }
    const labels = notes.map((n) => n.note.label);
    const shown = labels.length > 8 ? `${labels.slice(0, 8).join(', ')}, …` : labels.join(', ');
    return { kind: 'ok', text: `${notes.length} note${notes.length === 1 ? '' : 's'}: ${shown}` };
  }

  private computeViewState(): PlayingPracticeViewState {
    if (!this.sessionController) {
      return {
        phase: 'config',
        config: {
          strings: this.stringsSelected,
          patternType: this.patternType,
          direction: this.direction,
          minFrequencyText: this.minFrequencyText,
          maxFrequencyText: this.maxFrequencyText,
        },
        preview: this.computePreview(),
        configError: this.configErrorText,
      };
    }

    // `state.mode === 'complete'` is checked directly against the live
    // session (not the cache below) -- a sequence-completing success is
    // always rendered immediately (see applyResult()'s "straight to
    // complete" branch), so there is no pause-related staleness to guard
    // against here, only for the two active fields below.
    if (this.sessionController.state.mode === 'complete') {
      return { phase: 'session', session: { kind: 'complete' } };
    }

    const isDrilling = this.currentMode === 'drilling';
    return {
      phase: 'session',
      session: {
        kind: 'active',
        mode: this.currentMode,
        progressText: this.currentProgressText,
        targetNoteLabel: this.currentTargetNoteLabel,
        // Reused verbatim by Drilling as of Phase 7 -- no longer masked to
        // `undefined` for isDrilling, see the module doc comment.
        liveFeedbackText: this.liveFeedbackText,
        dwellFraction: this.dwellFraction,
        showGiveUpButton: !isDrilling,
        showSkipDrillButton: isDrilling,
        banner: this.currentBanner,
      },
    };
  }

  // --- Config mutators, one per sequence-settings control -----------------

  setStringSelected(name: ViolinStringName, selected: boolean): void {
    this.stringsSelected = { ...this.stringsSelected, [name]: selected };
    this.emit();
  }

  setPatternType(patternType: SequencePatternType): void {
    this.patternType = patternType;
    this.emit();
  }

  setDirection(direction: SequenceDirection): void {
    this.direction = direction;
    this.emit();
  }

  setMinFrequencyText(text: string): void {
    this.minFrequencyText = text;
    this.emit();
  }

  setMaxFrequencyText(text: string): void {
    this.maxFrequencyText = text;
    this.emit();
  }

  // --- Session lifecycle ----------------------------------------------

  /**
   * Reads the current config, generates a sequence, and starts a session --
   * or, on a structurally invalid or unproductive config, sets
   * `configError` and stays on the config phase. Mirrors
   * apps/desktop/src/playing-practice-ui.ts's `start()` exactly (including
   * which of the two failure messages applies to which case).
   */
  start(): void {
    let notes: readonly SequenceNote[];
    try {
      notes = generatePlayingPracticeSequence(this.readConfig());
    } catch (err) {
      this.configErrorText = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }
    if (notes.length === 0) {
      this.configErrorText =
        'This configuration produces no notes to practice — try widening the frequency range or picking a different pattern.';
      this.emit();
      return;
    }

    this.configErrorText = undefined;
    this.notes = notes;
    this.sessionController = new PracticeSessionController(notes);
    this.pauseUntilMs = undefined;
    this.renderCurrentState();
  }

  /** "Start a new sequence" -- discards the current session entirely and returns to the config screen (mirrors apps/desktop's `showConfigAgain()`). */
  restart(): void {
    this.sessionController = undefined;
    this.tracker = undefined;
    this.pauseUntilMs = undefined;
    this.notes = [];
    this.configErrorText = undefined;
    this.emit();
  }

  /**
   * "Having trouble? Skip this note" -- see `packages/core`'s
   * `PracticeAttemptTracker.giveUp()`. A no-op if no attempt is currently
   * in progress (no session started yet, or the current attempt is
   * already decided).
   *
   * **Timestamp domain, revised for Phase 7**: prior to Phase 7, the
   * timestamp passed to the underlying tracker was never actually read on
   * this code path (`giveUp()` always resolves to `{ status: 'failed',
   * reason: 'manual' }`, and a failure never scheduled a pause in Phase 6 --
   * only a success did) -- so `Date.now()` was used, deliberately avoiding
   * any doubt about `performance` being available in every environment this
   * class might run in. That justification no longer holds: as of Phase 7,
   * a failure that ends a drill via the attempt cap *does* schedule a
   * banner pause (`showDrillEndBanner`, via `pauseUntilMs`), compared
   * against `handleAnalysisFrame`'s `performance.now()`-based timestamps.
   * Mixing `Date.now()` (Unix-epoch-scale) into that comparison would make
   * `pauseUntilMs` permanently un-reachable (`performance.now()`'s small,
   * process-relative values would never exceed an epoch-scale
   * `pauseUntilMs`), silently stranding the banner forever. Not currently
   * reachable through this app's own UI (the give-up button is hidden
   * while drilling -- see `showGiveUpButton`), but this method has no way
   * to enforce that from the caller's side, so it's fixed at the source
   * instead of left as a latent trap: `performance.now()` (confirmed
   * available as a global in this app's Node/Vitest test environment, same
   * as Hermes/React Native at runtime -- `mic-capture-controller.ts`
   * already relies on it unguarded) now matches `handleAnalysisFrame`'s own
   * domain exactly, mirroring apps/desktop's `giveUpBtn` handler, which
   * always used `performance.now()` for the identical reason.
   */
  giveUp(): void {
    if (!this.tracker) return;
    this.applyResult(this.tracker.giveUp(), performance.now());
  }

  /**
   * "Skip this drill" (Phase 7) -- bypasses `PracticeAttemptTracker`
   * entirely (unlike `giveUp()` above), abandoning the whole drill
   * immediately via `PracticeSessionController.skipDrill()` (->
   * `DrillingMachine.skip()`), not just the current rep. A no-op if not
   * currently drilling (mirrors apps/desktop/src/playing-practice-ui.ts's
   * identical guard on `#pp-skip-drill-btn`'s click handler). Renders
   * immediately with no banner/pause -- a manual skip is already its own
   * signal, matching Playing Practice's own manual `giveUp()` precedent of
   * no flourish for a deliberate user action.
   */
  skipDrill(): void {
    if (!this.sessionController || this.sessionController.state.mode !== 'drilling') return;
    this.sessionController.skipDrill();
    this.renderCurrentState();
  }

  /**
   * Reflects `sessionController.state` into `notes`-derived display fields
   * and constructs a fresh `PracticeAttemptTracker` for whatever target
   * note is now active. Always builds a *new* tracker here (never
   * `reset()`s a stale one) -- even when Drilling's round-robin rotates
   * back to a note whose label repeats, this is a new attempt and should
   * get a clean dwell/timeout clock, not a continuation of a previous
   * rep's. Mirrors apps/desktop/src/playing-practice-ui.ts's
   * `renderCurrentState()`.
   */
  private renderCurrentState(): void {
    if (!this.sessionController) return;
    this.currentBanner = undefined;
    const state = this.sessionController.state;

    if (state.mode === 'complete') {
      this.tracker = undefined;
      this.emit();
      return;
    }

    const isDrilling = state.mode === 'drilling';
    this.currentMode = isDrilling ? 'drilling' : 'playing-practice';
    this.currentProgressText = isDrilling
      ? formatDrillProgress(state)
      : `Note ${state.index + 1} of ${this.notes.length}`;
    this.currentTargetNoteLabel = state.targetNote.note.label;

    // Live feedback + dwell progress: real Playing Practice scoring UI,
    // reused verbatim by Drilling as of Phase 7 (see the module doc
    // comment) -- no longer withheld for isDrilling. Reset unconditionally
    // on every new target regardless of mode: the fresh
    // PracticeAttemptTracker constructed below means a clean dwell/timeout
    // clock either way, so stale text/fill from the previous target must
    // not linger into this one.
    this.liveFeedbackText = '';
    this.dwellFraction = 0;
    this.tracker = new PracticeAttemptTracker(state.targetNote.frequencyHz);
    this.emit();
  }

  private applyResult(result: PracticeAttemptStatus, timestampMs: number): void {
    if (!this.sessionController) return;
    // Captured once, before reportOutcome() below can change it -- used
    // both to detect a drill-ending transition and (for the success case)
    // to mirror packages/core's mastery-vs-cap tie-break. See the module
    // doc comment for the full reasoning; verbatim-ported from
    // apps/desktop/src/playing-practice-ui.ts's own `applyResult()`.
    const stateBefore = this.sessionController.state;

    if (result.status === 'in-progress') {
      // Reused verbatim by Drilling as of Phase 7 -- no longer skipped for
      // a drilling rep, see the module doc comment and
      // renderCurrentState()'s own comment on the dwell bar.
      this.dwellFraction = Math.min(1, result.heldMs / DEFAULT_MIN_DWELL_TIME_MS);
      this.emit();
      return;
    }

    if (result.status === 'succeeded') {
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
          // consecutiveCorrect/requiredConsecutiveCorrect fields captured
          // in `stateBefore` -- see the module doc comment for why this is
          // a deliberate, flagged UI-layer mirror of a stable contract, not
          // a change to packages/core's public API.
          const mastered =
            stateBefore.consecutiveCorrect + 1 >= stateBefore.requiredConsecutiveCorrect;
          this.showDrillEndBanner(mastered ? 'mastered' : 'capped', timestampMs);
          return;
        }
        // Still drilling (a 'continue' outcome) -- no success flourish for
        // a single rep; the rotated target note plus the progress line's
        // counters advancing together is the visible signal (see the
        // module doc comment on the deliberate no-role-indicator choice).
        this.renderCurrentState();
        return;
      }

      if (this.sessionController.state.mode === 'complete') {
        // Go straight to the "Sequence complete!" screen rather than
        // queuing the usual "Nice!" pause below -- the complete screen is
        // itself a clear success indicator, and this avoids a real (if
        // narrow) bug the pause would otherwise have: `pauseUntilMs` is
        // only ever cleared by a *later* `handleAnalysisFrame` call (there
        // is no real setTimeout backing it), so if capture stops right as
        // the very last note succeeds, no later frame would ever arrive to
        // clear the pause and reveal the complete screen. Calling the
        // synchronous `renderCurrentState()` directly here has no such
        // dependency. Non-final successes still get the ordinary pause
        // below -- being stuck an extra beat on the *current*
        // (already-correct) target note if capture happens to stop
        // mid-pause is a much smaller, self-recovering staleness than
        // never reaching "complete" at all.
        this.renderCurrentState();
        return;
      }
      this.currentBanner = { text: 'Nice!', tone: 'success' };
      this.pauseUntilMs = timestampMs + SUCCESS_PAUSE_MS;
      this.emit();
      return;
    }

    // result.status === 'failed' (timeout or manual giveUp())
    this.sessionController.reportOutcome('failure');
    if (stateBefore.mode === 'drilling' && this.sessionController.state.mode !== 'drilling') {
      // Unlike the success path above, no inference is needed here: a
      // failure can only ever end a drill via the attempt cap, never
      // mastery (again see DrillingMachine.reportOutcome) -- this is
      // unambiguously 'max-attempts-reached'.
      this.showDrillEndBanner('capped', timestampMs);
      return;
    }
    // Otherwise: either a plain Playing-Practice-level failure that just
    // *started* a new drill (state.mode is now 'drilling', so the guard
    // above correctly does not treat this as a drill *ending*) or a
    // continuing drill rep -- no special flourish either way; the
    // mode/target-note change on the very next render is itself the
    // visible signal.
    this.renderCurrentState();
  }

  /**
   * Shows the brief "Mastered!"/"Moving on" banner when a drill ends, then
   * -- exactly like the "Nice!" pause above -- hands control back after
   * `SUCCESS_PAUSE_MS`. Verbatim-ported from
   * apps/desktop/src/playing-practice-ui.ts's own `showDrillEndBanner()`,
   * including its complete-screen special case: `pauseUntilMs` has no real
   * timer backing it (only a later `handleAnalysisFrame` call clears it),
   * so if a mastered/capped drill's `resumeAtIndex` lands on `'complete'`
   * and capture happens to stop right then, no later frame would ever
   * arrive to reveal the complete screen -- skip the pause and render
   * immediately instead, same as the plain success path above.
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
    this.emit();
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * App.tsx's `onAnalysis` callback alongside (not instead of) the
   * existing Finger Tuner code, using the exact same
   * `reading`/`rawReading`/timestamp values that code already computes for
   * `TunerDisplaySmoother` -- see App.tsx's own comment on why one shared
   * `performance.now()` read per hop feeds both. A no-op whenever no
   * sequence has been started yet (`this.sessionController` undefined).
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
    // `!== 'complete'`: the state is a 3-way union, and only a
    // positive-literal check narrows `state.targetNote` into scope. In
    // practice `this.tracker` is undefined whenever mode is 'complete' (see
    // renderCurrentState()), so the guard above already rules that case out
    // at runtime -- mirrors apps/desktop's own identical comment on this
    // exact point. As of Phase 7 this covers 'drilling' too (previously
    // 'playing-practice' only) -- see the module doc comment on reusing the
    // live-feedback line for Drilling attempts.
    const state = this.sessionController.state;
    if (state.mode === 'playing-practice' || state.mode === 'drilling') {
      this.liveFeedbackText = formatLiveFeedback(rawReading, state.targetNote.frequencyHz);
    }

    this.applyResult(this.tracker.update(reading, timestampMs), timestampMs);
  }
}

/**
 * A fresh controller's initial view state, computed once at module load
 * (not per `App` mount) -- used as App.tsx's plain `useState` initial
 * value (not a lazy-initializer function; a module-level constant needs
 * neither) so the config screen's live preview is populated from the very
 * first render, without App.tsx needing its own inline
 * `new PlayingPracticeController().getViewState()` call or a synchronous
 * `onChange` push from the constructor (see `getViewState()`'s own comment
 * for why the latter is deliberately not how this class reports its
 * starting state). Also gives this exact starting shape a name this
 * module's own tests can assert against directly (see
 * `playing-practice-controller.test.ts`'s "initial state" tests).
 */
export const INITIAL_PLAYING_PRACTICE_VIEW_STATE: PlayingPracticeViewState =
  new PlayingPracticeController().getViewState();
