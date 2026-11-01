/**
 * ABC Notation practice (mobile): import an ABC file, pick a tune, and
 * practice its notes in order -- the sheet-music sibling of Playing Practice,
 * and the mobile counterpart of `apps/desktop/src/abc-practice-ui.ts`.
 * Parsing and the sequence conversion are `packages/core`'s `parseAbc` /
 * `buildAbcPracticeSequence` (shared with desktop).
 *
 * There are two ways to practice a tune ("practice style"):
 *
 *  - **Play along** (the default): a timed run. A visual metronome keeps the
 *    tempo, the piece advances on the beat, and every note must be played in
 *    tune *and* on time; the notes that were missed are listed at the end.
 *    The run is `packages/core`'s `PlayAlongRunner`, wrapped here; there is no
 *    Drilling (the clock cannot stop).
 *  - **Wait for me**: the original untimed flow. The app holds still until
 *    each note is right; a missed note drills that note and its neighbors.
 *    This is the very same `PracticeSessionRunner` Playing Practice uses, fed
 *    the tune's notes (plus, for sheet music, the key and the piece so the
 *    letters are spelled as the sheet spells them and the Staff display can
 *    draw the notated score).
 *
 * ## The tempo
 *
 * The tempo is read from the file (`Q:`) -- or defaulted when there is none --
 * and the user can change it from the UI **without touching the file**: this
 * controller only keeps a number (`tempoOverride`, in the piece's own beat
 * unit) and hands it to the play-along plan, which scales every tempo mark in
 * the piece by the same ratio. It resets to the written tempo whenever the
 * file, the tune or the transposition changes, because a tempo chosen for one
 * piece means nothing for another.
 *
 * ## Why play-along is not pushed through `onChange` per frame
 *
 * Analysis frames arrive ~86 times a second. The Wait-for-me runner already
 * pushes a fresh view state to React on most of them (its dwell bar), which is
 * tolerable for one small screen; a moving score, a playhead and beat dots are
 * not. So in play-along the controller keeps NO per-frame state of its own:
 * `handleAnalysisFrame` feeds the runner and returns, `onChange` fires only on
 * discrete user actions (start, stop, play again, ...), and the screen polls
 * `getPlayAlongView()` at ~30 fps -- only while a run is live -- re-rendering
 * only when something visible changed (see `play-along-view-state.ts`). There
 * are no timers in here.
 *
 * ## Clocks
 *
 * The run's display time comes from `nowMs` (default `performance.now()`) and
 * its scoring time from the frames' timestamps; they must be the same clock.
 * App.tsx stamps every hop with `performance.now()` and passes that to
 * `handleAnalysisFrame`, so they are. Tests inject their own `nowMs`.
 *
 * ## No audible click on mobile (deliberate)
 *
 * The runner is created without a `click`, so a mobile run is silent: the beat
 * is shown (dots, count-in number) but not heard. The app configures the iOS
 * audio session as `record` + `measurement`
 * (`MicCaptureController.configureSession`); playing a click needs
 * `playAndRecord`, which could change how the instrument input is captured --
 * and pitch correctness is the first priority -- so that is left for a change
 * that can be tried on a real device. See `apps/mobile/CLAUDE.md`.
 *
 * Headless and React-Native-import-free, like `PlayingPracticeController`: it
 * computes a plain `AbcPracticeViewState` snapshot and pushes it to
 * `events.onChange` for `./AbcPracticeScreen.tsx` to render. The one thing
 * that needs the platform -- showing the system file picker and reading the
 * chosen file -- is injected as `pickFile` (see `./abc-file-picker.ts` for the
 * real one), which keeps this class independently unit-testable.
 */

import {
  MAX_TEMPO_BPM,
  MIN_TEMPO_BPM,
  PlayAlongRunner,
  abcPracticeSummary,
  abcTuneLabel,
  buildAbcPracticeSequence,
  clampTempoBpm,
  countInBeatsForBars,
  describeTempoSettings,
  fingerMarksOf,
  notesAtIndices,
  parseAbc,
  type AbcPiece,
  type AbcPracticeSequence,
  type AbcTune,
  type FingerMark,
  type FingerTunerReading,
  type PitchReading,
  type PlayAlongRunView,
  type TempoSettings,
} from '@violin/core';
import {
  PracticeSessionRunner,
  type PlayingPracticeSessionViewState,
} from './practice-session-runner';

/**
 * How much later than on desktop an analysis frame reaches the play-along
 * scorer on mobile, ms. The recorder hands the JS thread a 2048-sample buffer
 * (~46ms) at a time, which is split into four hops stamped when the buffer
 * *arrives*: on average a hop is stamped ~17ms (1.5 hops) after its audio
 * ended, plus the native-to-JS bridge. ~30ms is that sum, rounded -- a
 * reasoned estimate, **not measured on a device** (there was none), so treat it
 * as the first thing to tune on one. It only shifts the scorer's timing window
 * (core's `extraLatencyMs`); the window itself is 100-250ms wide, so being off
 * by a few tens of ms costs accuracy of the "you tend to play late" sentence,
 * not whether a note counts.
 */
export const MOBILE_FRAME_DELIVERY_LAG_MS = 30;

/** A file the user picked: its display name and its decoded text. */
export interface PickedAbcFile {
  readonly name: string;
  readonly text: string;
}

/**
 * Shows the system file picker. Resolves `undefined` if the user cancelled;
 * rejects with an `Error` whose message is fit to show the user if the file
 * couldn't be read.
 */
export type AbcFilePicker = () => Promise<PickedAbcFile | undefined>;

export interface AbcTuneOption {
  readonly index: number;
  readonly label: string;
}

/** Semitone shifts offered by the transpose control. */
export const ABC_TRANSPOSE_CHOICES: ReadonlyArray<{ semitones: number; label: string }> = [
  { semitones: -24, label: '−2 oct' },
  { semitones: -12, label: '−1 oct' },
  { semitones: 0, label: 'As written' },
  { semitones: 12, label: '+1 oct' },
  { semitones: 24, label: '+2 oct' },
];

/** How the tune is practiced: a timed run with a metronome, or the app waiting for each note. */
export type AbcPracticeStyle = 'play-along' | 'wait';

export const ABC_STYLE_CHOICES: ReadonlyArray<{ value: AbcPracticeStyle; label: string }> = [
  { value: 'play-along', label: 'Play along' },
  { value: 'wait', label: 'Wait for me' },
];

/** Bars of metronome clicks before a play-along starts (0 = none). */
export type AbcCountInBars = 0 | 1 | 2;

export const ABC_COUNT_IN_CHOICES: ReadonlyArray<{ value: AbcCountInBars; label: string }> = [
  { value: 1, label: 'One bar' },
  { value: 2, label: 'Two bars' },
  { value: 0, label: 'None' },
];

/**
 * The tempo block of the import screen (play-along). What the tempo control
 * shows and allows -- the clamped tempo, the written one, the beat symbol, the
 * percentage and the hint wording -- is decided once in `packages/core`
 * (`describeTempoSettings`, shared with desktop) and carried here unchanged in
 * `settings`.
 */
export interface AbcTempoViewState {
  readonly settings: TempoSettings;
  /** The allowed range, for the stepper buttons. */
  readonly minBpm: number;
  readonly maxBpm: number;
  /** Where the written tempo came from: the file, or a gentle default because the file has none ("Reset to default tempo"). */
  readonly source: 'file' | 'default';
  /** Metronome clicks of the chosen count-in ("One bar" before a pickup piece is fewer than a full bar). */
  readonly countInBeats: number;
}

/** What stays the same during one play-along run (the moving parts are polled via `getPlayAlongView`). */
export interface AbcPlayAlongRunInfo {
  /** Changes with every new run (start, play again) so the screen restarts its polling. */
  readonly runId: number;
  /** The piece being played: the score layout is built from it. */
  readonly piece: AbcPiece;
  readonly tempoBpm: number;
  readonly countInBeats: number;
  /** Finger numbers for the notes of `piece` (index = note), or `undefined` when switched off. Stable for the run. */
  readonly fingers: readonly (FingerMark | undefined)[] | undefined;
}

export type AbcPracticeViewState =
  | {
      readonly phase: 'import';
      /** Name of the last imported file, if any. */
      readonly fileName: string | undefined;
      /** True while the picker is open / the file is being read. */
      readonly loading: boolean;
      /** Empty until a file with at least one tune has been imported. */
      readonly tunes: readonly AbcTuneOption[];
      readonly selectedTuneIndex: number | undefined;
      readonly transposeSemitones: number;
      /** Multi-line preview of the selected tune (see core's `abcPracticeSummary`); `''` before an import. */
      readonly summaryText: string;
      /** Things the parser noticed and couldn't represent exactly (chords reduced to their top note, etc.). */
      readonly warnings: readonly string[];
      /** Why the selection can't be practiced (or the file couldn't be loaded); `undefined` when fine. */
      readonly error: string | undefined;
      readonly canStart: boolean;
      readonly style: AbcPracticeStyle;
      readonly countInBars: AbcCountInBars;
      /** Whether finger numbers are shown (on the score and under the note name). */
      readonly showFingers: boolean;
      /** Tempo and count-in details of the selected tune; `undefined` when nothing practicable is selected. */
      readonly tempo: AbcTempoViewState | undefined;
    }
  | {
      readonly phase: 'session';
      readonly session: PlayingPracticeSessionViewState;
      /** True for the follow-up session over just the notes missed in a play-along. */
      readonly missedNotesOnly?: true;
    }
  | { readonly phase: 'play-along'; readonly run: AbcPlayAlongRunInfo };

export interface AbcPracticeControllerEvents {
  readonly onChange?: (state: AbcPracticeViewState) => void;
}

export interface AbcPracticeControllerOptions {
  /** The clock a play-along run is timed by; must be the clock of the frame timestamps. Default `performance.now()`. */
  readonly nowMs?: () => number;
}

/** What a play-along run was started with, so "Play again" can repeat it exactly. */
interface PlayAlongSetup {
  readonly piece: AbcPiece;
  readonly tempoBpm: number;
  readonly countInBeats: number;
}

export class AbcPracticeController {
  private fileName: string | undefined;
  private loading = false;
  private tunes: readonly AbcTune[] = [];
  private fileWarnings: readonly string[] = [];
  private selectedTuneIndex: number | undefined;
  private transposeSemitones = 0;
  private loadError: string | undefined;

  private style: AbcPracticeStyle = 'play-along';
  private countInBars: AbcCountInBars = 1;
  private showFingers = true;
  /** The user's tempo, or undefined for "as written". Reset whenever the file, tune or transposition changes. */
  private tempoOverride: number | undefined;
  /** Why the last attempt to start failed (an unusable piece for the play-along plan); cleared by any settings change. */
  private startError: string | undefined;

  private playAlong: { readonly runner: PlayAlongRunner; info: AbcPlayAlongRunInfo } | undefined;
  /** The last play-along's settings, kept through the "practice missed notes" follow-up so "Play again" works from there. */
  private playAlongSetup: PlayAlongSetup | undefined;
  private runCounter = 0;
  private missedNotesSession = false;

  private cachedBuild:
    | {
        readonly tunes: readonly AbcTune[];
        readonly tuneIndex: number | undefined;
        readonly transposeSemitones: number;
        readonly value: { tune: AbcTune; result: AbcPracticeSequence } | undefined;
      }
    | undefined;

  private readonly runner = new PracticeSessionRunner({
    onChange: () => this.emit(),
    showUpcoming: true,
  });
  private readonly nowMs: () => number;

  constructor(
    private readonly pickFile: AbcFilePicker,
    private readonly events: AbcPracticeControllerEvents = {},
    options: AbcPracticeControllerOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  /** Current snapshot -- safe to call any time; never pushes via `onChange` (see `PlayingPracticeController.getViewState`). */
  getViewState(): AbcPracticeViewState {
    return this.computeViewState();
  }

  /**
   * The live play-along view (count-in, beat, playhead position, note states,
   * feedback, results) or `undefined` when no run exists. Cheap enough to call
   * at screen rate; the screen polls it while a run is live. See the module doc
   * for why this is not part of the pushed view state.
   */
  getPlayAlongView(): PlayAlongRunView | undefined {
    return this.playAlong?.runner.getView();
  }

  private emit(): void {
    this.events.onChange?.(this.computeViewState());
  }

  private selectedTune(): AbcTune | undefined {
    return this.tunes.find((t) => t.index === this.selectedTuneIndex);
  }

  /** The selected tune turned into a practice sequence at the current transposition, or undefined. Cached: tempo edits must not rebuild the piece. */
  private build() {
    const cached = this.cachedBuild;
    if (
      cached &&
      cached.tunes === this.tunes &&
      cached.tuneIndex === this.selectedTuneIndex &&
      cached.transposeSemitones === this.transposeSemitones
    ) {
      return cached.value;
    }
    const tune = this.selectedTune();
    const value = tune
      ? {
          tune,
          result: buildAbcPracticeSequence(tune, { transposeSemitones: this.transposeSemitones }),
        }
      : undefined;
    this.cachedBuild = {
      tunes: this.tunes,
      tuneIndex: this.selectedTuneIndex,
      transposeSemitones: this.transposeSemitones,
      value,
    };
    return value;
  }

  /** What the tempo control shows: the user's tempo if they set one, else the written one. */
  private tempoSettingsFor(piece: AbcPiece): TempoSettings {
    return describeTempoSettings(piece, this.tempoOverride ?? piece.tempo.bpm);
  }

  /**
   * The tempo a run is built at. Left as the file wrote it (even a fractional
   * 92.5) while the user has not touched it and it is within the allowed
   * range; otherwise the clamped whole number the control shows.
   */
  private effectiveTempoBpm(piece: AbcPiece): number {
    const fileBpm = piece.tempo.bpm;
    const untouched =
      this.tempoOverride === undefined && fileBpm >= MIN_TEMPO_BPM && fileBpm <= MAX_TEMPO_BPM;
    return untouched ? fileBpm : this.tempoSettingsFor(piece).bpm;
  }

  private tempoViewFor(piece: AbcPiece): AbcTempoViewState {
    return {
      settings: this.tempoSettingsFor(piece),
      minBpm: MIN_TEMPO_BPM,
      maxBpm: MAX_TEMPO_BPM,
      source: piece.tempoSource,
      countInBeats: countInBeatsForBars(piece, this.countInBars),
    };
  }

  private computeViewState(): AbcPracticeViewState {
    const session = this.runner.getView();
    if (session) {
      return {
        phase: 'session',
        session,
        ...(this.missedNotesSession ? { missedNotesOnly: true as const } : {}),
      };
    }
    if (this.playAlong) return { phase: 'play-along', run: this.playAlong.info };

    const built = this.build();
    const common = {
      phase: 'import' as const,
      fileName: this.fileName,
      loading: this.loading,
      tunes: this.tunes.map((t) => ({ index: t.index, label: abcTuneLabel(t) })),
      selectedTuneIndex: this.selectedTuneIndex,
      transposeSemitones: this.transposeSemitones,
      style: this.style,
      countInBars: this.countInBars,
      showFingers: this.showFingers,
    };
    if (!built) {
      return {
        ...common,
        summaryText: '',
        warnings: [],
        error: this.loadError,
        canStart: false,
        tempo: undefined,
      };
    }
    const ok = built.result.status === 'ok';
    return {
      ...common,
      summaryText: abcPracticeSummary(built.tune, built.result),
      warnings: [...built.tune.warnings, ...this.fileWarnings],
      error: built.result.status === 'ok' ? this.startError : built.result.message,
      canStart: ok,
      tempo: built.result.status === 'ok' ? this.tempoViewFor(built.result.piece) : undefined,
    };
  }

  // --- Importing -------------------------------------------------------

  /** Shows the file picker and, if a file was chosen, loads it. Safe to call while a previous import is still in flight (ignored). */
  async importFile(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.emit();
    try {
      const picked = await this.pickFile();
      if (picked) {
        this.loadText(picked.name, picked.text);
        return;
      }
    } catch (err) {
      this.setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  private setLoadError(message: string): void {
    this.tunes = [];
    this.fileWarnings = [];
    this.selectedTuneIndex = undefined;
    this.loadError = message;
    this.tempoOverride = undefined;
    this.startError = undefined;
  }

  /** Parses `text` as an ABC file and selects its first tune that has notes. Used by `importFile`; public so it can be driven directly. */
  loadText(name: string, text: string): void {
    this.fileName = name;
    const result = parseAbc(text);
    if (result.tunes.length === 0) {
      this.setLoadError(result.warnings.join(' '));
      this.emit();
      return;
    }
    this.loadError = undefined;
    this.tunes = result.tunes;
    this.fileWarnings = result.warnings;
    const firstWithNotes = result.tunes.find((t) => t.voices.some((v) => v.notes.length > 0));
    this.selectedTuneIndex = (firstWithNotes ?? result.tunes[0]!).index;
    this.transposeSemitones = 0;
    // A tempo chosen for one file means nothing for another.
    this.tempoOverride = undefined;
    this.startError = undefined;
    this.emit();
  }

  selectTune(index: number): void {
    if (!this.tunes.some((t) => t.index === index)) return;
    if (index === this.selectedTuneIndex) return;
    this.selectedTuneIndex = index;
    this.tempoOverride = undefined;
    this.startError = undefined;
    this.emit();
  }

  setTranspose(semitones: number): void {
    if (semitones === this.transposeSemitones) return;
    this.transposeSemitones = semitones;
    // A different transposition is a different piece as far as the tempo goes (and the keys differ).
    this.tempoOverride = undefined;
    this.startError = undefined;
    this.emit();
  }

  // --- Practice settings ---------------------------------------------------

  setStyle(style: AbcPracticeStyle): void {
    if (style === this.style) return;
    this.style = style;
    this.startError = undefined;
    this.emit();
  }

  /** Drilling on/off for Wait for me (default on); off = a missed note moves straight on. Play along never drills. */
  setDrillingEnabled(enabled: boolean): void {
    this.runner.setDrillingEnabled(enabled);
  }

  /** Finger numbers on/off, at once: on the import screen's next start, and live in a running session or play-along. */
  setFingers(on: boolean): void {
    if (on === this.showFingers) return;
    this.showFingers = on;
    this.runner.setFingers(on);
    if (this.playAlong) {
      // Same run, new marks (a new `info` object so the panel re-renders; `runId` is unchanged).
      this.playAlong.info = {
        ...this.playAlong.info,
        fingers: on ? fingerMarksOf(this.playAlong.info.piece.notes) : undefined,
      };
    }
    this.emit();
  }

  setCountIn(bars: AbcCountInBars): void {
    if (bars === this.countInBars) return;
    this.countInBars = bars;
    this.startError = undefined;
    this.emit();
  }

  /** Sets the play-along tempo (beats per minute of the piece's own beat). Rounded and kept within `MIN_TEMPO_BPM..MAX_TEMPO_BPM`; a non-number is ignored. The file is never modified. */
  setTempo(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    this.tempoOverride = clampTempoBpm(bpm);
    this.startError = undefined;
    this.emit();
  }

  /** Back to the tempo the file gives (or the default when it has none). */
  resetTempo(): void {
    if (this.tempoOverride === undefined) return;
    this.tempoOverride = undefined;
    this.startError = undefined;
    this.emit();
  }

  // --- Session lifecycle -------------------------------------------------

  /** Starts practicing the selected tune in the chosen style. A no-op if nothing practicable is selected. */
  start(): void {
    const built = this.build();
    if (!built || built.result.status !== 'ok') return;
    const { piece, notes } = built.result;
    this.startError = undefined;
    this.missedNotesSession = false;

    if (this.style === 'wait') {
      this.playAlong = undefined;
      this.playAlongSetup = undefined;
      this.runner.begin(notes, { key: piece.keyAtStart, piece, fingers: this.showFingers });
      return;
    }
    this.startPlayAlong({
      piece,
      tempoBpm: this.effectiveTempoBpm(piece),
      countInBeats: countInBeatsForBars(piece, this.countInBars),
    });
  }

  /** Builds and starts a run. A piece the plan cannot be built for (a corrupt meter, say) is reported on the import screen rather than thrown. */
  private startPlayAlong(setup: PlayAlongSetup): void {
    let runner: PlayAlongRunner;
    try {
      runner = new PlayAlongRunner({
        piece: setup.piece,
        tempoBpm: setup.tempoBpm,
        countInBeats: setup.countInBeats,
        nowMs: this.nowMs,
        // No `click`: a mobile run is silent (see the module doc).
        config: { extraLatencyMs: MOBILE_FRAME_DELIVERY_LAG_MS },
      });
    } catch (err) {
      this.playAlong = undefined;
      this.startError = `This piece cannot be played along: ${err instanceof Error ? err.message : String(err)}`;
      this.emit();
      return;
    }
    this.runner.end();
    this.missedNotesSession = false;
    this.playAlongSetup = setup;
    runner.start();
    this.runCounter += 1;
    this.playAlong = {
      runner,
      info: {
        runId: this.runCounter,
        piece: setup.piece,
        tempoBpm: setup.tempoBpm,
        countInBeats: setup.countInBeats,
        fingers: this.showFingers ? fingerMarksOf(setup.piece.notes) : undefined,
      },
    };
    this.emit();
  }

  /**
   * Stop button. The run ends where it is; the results (the notes judged so
   * far, the rest "not reached") are shown -- unless nothing had been judged
   * yet (stopped during the count-in, say), in which case there is nothing to
   * report and the settings come straight back.
   */
  stopPlayAlong(): void {
    const run = this.playAlong;
    if (!run) return;
    run.runner.stop();
    const summary = run.runner.getView().summary;
    if (!summary || summary.hits + summary.missedNoteIndices.length === 0) {
      this.playAlong = undefined;
      this.emit();
    }
    // Otherwise the view state is unchanged ('play-along'); the screen's
    // poll picks the finished run up within a frame.
  }

  /** "Play again": a new run with the same piece, tempo and count-in. */
  playAgain(): void {
    const setup = this.playAlongSetup;
    if (!setup) return;
    this.playAlong?.runner.stop();
    this.startPlayAlong(setup);
  }

  /**
   * "Practice missed notes": a Wait-for-me session over just the notes the
   * finished play-along missed, each practiced on its own (their neighbors in
   * the piece are not included). No-op unless a finished run missed something.
   */
  practiceMissedNotes(): void {
    const run = this.playAlong;
    if (!run) return;
    const missed = run.runner.getView().summary?.missedNoteIndices ?? [];
    const notes = notesAtIndices(run.info.piece, missed);
    if (notes.length === 0) return;
    this.playAlong = undefined;
    this.missedNotesSession = true;
    // No `piece`: these notes are not the piece in order, so a score window
    // around "the target's bar" would show the wrong neighbors. They are
    // still spelled the sheet's way (the key).
    this.runner.begin(notes, { key: run.info.piece.keyAtStart, fingers: this.showFingers });
  }

  /** "Change settings" / "Practice another piece": back to the import screen, with the file, tune, transposition and tempo as they were. */
  changeSettings(): void {
    this.restart();
  }

  /** Discards whatever is running and returns to the import screen (the imported file and selection are kept). */
  restart(): void {
    this.playAlong?.runner.stop();
    this.playAlong = undefined;
    this.playAlongSetup = undefined;
    this.missedNotesSession = false;
    this.runner.end();
    this.emit();
  }

  giveUp(): void {
    this.runner.giveUp();
  }

  skipDrill(): void {
    this.runner.skipDrill();
  }

  /** Feeds one analysis hop to whatever is running (a play-along run or a Wait-for-me session); a no-op when neither is. */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    if (this.playAlong) {
      this.playAlong.runner.handleFrame(reading, rawReading, timestampMs);
      return;
    }
    this.runner.handleAnalysisFrame(reading, rawReading, timestampMs);
  }
}

/** A fresh controller's starting snapshot, for App.tsx's `useState` initializer (the controller itself never pushes it via `onChange`). */
export const INITIAL_ABC_PRACTICE_VIEW_STATE: AbcPracticeViewState = new AbcPracticeController(
  async () => undefined,
).getViewState();
