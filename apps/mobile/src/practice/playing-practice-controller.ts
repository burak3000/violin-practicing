/**
 * Phase 6 Part B: the headless (React-Native-import-free) controller behind
 * the mobile Playing Practice mode -- the RN analogue of
 * apps/desktop/src/playing-practice-ui.ts's `PlayingPracticeUi`, fed by the
 * exact same Phase 4 capture -> DSP pipeline as Finger Tuner (see
 * apps/mobile/App.tsx) -- but through `packages/core`'s
 * `PracticeAttemptTracker`, not `analyzeTunerReading`'s raw output and NOT
 * `TunerDisplaySmoother` (that class is for continuous tuner display; this
 * is discrete, single-note, dwell-and-give-up scoring against a specific
 * target -- a different job, see `packages/core/CLAUDE.md`'s "Session state
 * machines" section).
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
 * ## Config here, session in `./practice-session-runner.ts`
 *
 * This class owns the *configuration* half: the sequence-settings controls,
 * the live preview, and generating the sequence on Start. Running the session
 * itself -- the `PracticeSessionController` Playing Practice <-> Drilling
 * hand-off, per-note `PracticeAttemptTracker` scoring, banners, the Drilling
 * UI's live feedback/dwell/progress/skip behavior -- lives in
 * `PracticeSessionRunner`, extracted so ABC Notation practice
 * (`./abc-practice-controller.ts`) shares it verbatim. The Phase 7 design
 * notes (no per-drill-note role label, mastered-vs-capped inferred in the UI
 * layer, `giveUp()`'s timestamp domain) moved with that code and are
 * unchanged; see also `apps/mobile/CLAUDE.md`'s "Phase 6 Part B" and "Phase 7
 * Part B" sections.
 */

import {
  DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ,
  DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ,
  VIOLIN_STRING_ORDER,
  generatePlayingPracticeSequence,
  type FingerTunerReading,
  type PitchReading,
  type SequenceDirection,
  type SequenceGeneratorConfig,
  type SequenceNote,
  type SequencePatternType,
  type ViolinStringName,
} from '@violin/core';
import {
  PracticeSessionRunner,
  type PlayingPracticeSessionViewState,
} from './practice-session-runner';

// The session view-state types now live with the runner that produces them;
// re-exported so existing importers (PlayingPracticeScreen.tsx, App.tsx,
// tests) keep importing them from here.
export type {
  PlayingPracticeBanner,
  PlayingPracticeSessionViewState,
} from './practice-session-runner';

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
 * Owns the mobile Playing Practice mode's configuration controls and hands
 * the generated sequence to a `PracticeSessionRunner`. One instance for the
 * app's lifetime (mirrors `MicCaptureController`'s own "one instance,
 * event-callback" shape) -- constructed once in App.tsx and fed every analysis
 * hop via `handleAnalysisFrame`, regardless of which mode tab is currently
 * visible (see apps/desktop/CLAUDE.md's "Mode switcher" section for why:
 * switching back to this tab should not have lost its place in the
 * sequence, and there's no reason to run two separate audio pipelines for
 * one microphone -- App.tsx keeps every mode's state fed from the same
 * single `onAnalysis` callback).
 */
export class PlayingPracticeController {
  // --- Config state (config phase only, but harmless to mutate anytime) --
  private stringsSelected: StringSelection = ALL_STRINGS_SELECTED;
  private patternType: SequencePatternType = 'stepwise-first-position';
  private direction: SequenceDirection = 'ascending';
  private minFrequencyText: string = String(DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ);
  private maxFrequencyText: string = String(DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ);
  private configErrorText: string | undefined;

  private readonly runner = new PracticeSessionRunner({ onChange: () => this.emit() });

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
    const session = this.runner.getView();
    if (session) {
      return { phase: 'session', session };
    }
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
    this.runner.begin(notes);
  }

  /** "Start a new sequence" -- discards the current session entirely and returns to the config screen (mirrors apps/desktop's `showConfigAgain()`). */
  restart(): void {
    this.runner.end();
    this.configErrorText = undefined;
    this.emit();
  }

  /** "Having trouble? Skip this note" -- see `PracticeSessionRunner.giveUp()`. */
  giveUp(): void {
    this.runner.giveUp();
  }

  /** "Skip this drill" -- see `PracticeSessionRunner.skipDrill()`. */
  skipDrill(): void {
    this.runner.skipDrill();
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * App.tsx's `onAnalysis` callback alongside (not instead of) the
   * existing Finger Tuner code, using the exact same
   * `reading`/`rawReading`/timestamp values that code already computes for
   * `TunerDisplaySmoother`. A no-op whenever no sequence has been started yet.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    this.runner.handleAnalysisFrame(reading, rawReading, timestampMs);
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
