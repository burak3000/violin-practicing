/**
 * ABC Notation practice (mobile): import an ABC file, pick a tune, and
 * practice its notes in order -- the sheet-music sibling of Playing Practice,
 * and the mobile counterpart of `apps/desktop/src/abc-practice-ui.ts`.
 * Parsing and the sequence conversion are `packages/core`'s `parseAbc` /
 * `buildAbcPracticeSequence` (shared with desktop); the session itself
 * (target note, scoring, Drilling on a miss, banners, completion) is the very
 * same `PracticeSessionRunner` Playing Practice uses, fed an ABC-derived
 * `SequenceNote[]` -- so a missed note drills that note and its neighbors in
 * the tune exactly like it does in a scale.
 *
 * Headless and React-Native-import-free, like `PlayingPracticeController`: it
 * computes a plain `AbcPracticeViewState` snapshot and pushes it to
 * `events.onChange` for `./AbcPracticeScreen.tsx` to render. The one thing
 * that needs the platform -- showing the system file picker and reading the
 * chosen file -- is injected as `pickFile` (see `./abc-file-picker.ts` for the
 * real one), which keeps this class independently unit-testable.
 */

import {
  abcPracticeSummary,
  abcTuneLabel,
  buildAbcPracticeSequence,
  parseAbc,
  type AbcTune,
  type FingerTunerReading,
  type PitchReading,
  type SequenceNote,
} from '@violin/core';
import {
  PracticeSessionRunner,
  type PlayingPracticeSessionViewState,
} from './practice-session-runner';

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
  { semitones: -24, label: '\u22122 oct' },
  { semitones: -12, label: '\u22121 oct' },
  { semitones: 0, label: 'As written' },
  { semitones: 12, label: '+1 oct' },
  { semitones: 24, label: '+2 oct' },
];

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
    }
  | { readonly phase: 'session'; readonly session: PlayingPracticeSessionViewState };

export interface AbcPracticeControllerEvents {
  readonly onChange?: (state: AbcPracticeViewState) => void;
}

export class AbcPracticeController {
  private fileName: string | undefined;
  private loading = false;
  private tunes: readonly AbcTune[] = [];
  private fileWarnings: readonly string[] = [];
  private selectedTuneIndex: number | undefined;
  private transposeSemitones = 0;
  private loadError: string | undefined;

  private readonly runner = new PracticeSessionRunner({
    onChange: () => this.emit(),
    showUpcoming: true,
  });

  constructor(
    private readonly pickFile: AbcFilePicker,
    private readonly events: AbcPracticeControllerEvents = {},
  ) {}

  /** Current snapshot -- safe to call any time; never pushes via `onChange` (see `PlayingPracticeController.getViewState`). */
  getViewState(): AbcPracticeViewState {
    return this.computeViewState();
  }

  private emit(): void {
    this.events.onChange?.(this.computeViewState());
  }

  private selectedTune(): AbcTune | undefined {
    return this.tunes.find((t) => t.index === this.selectedTuneIndex);
  }

  /** The selected tune turned into a practice sequence at the current transposition, or undefined. */
  private build() {
    const tune = this.selectedTune();
    if (!tune) return undefined;
    return {
      tune,
      result: buildAbcPracticeSequence(tune, { transposeSemitones: this.transposeSemitones }),
    };
  }

  private computeViewState(): AbcPracticeViewState {
    const session = this.runner.getView();
    if (session) return { phase: 'session', session };

    const built = this.build();
    const common = {
      phase: 'import' as const,
      fileName: this.fileName,
      loading: this.loading,
      tunes: this.tunes.map((t) => ({ index: t.index, label: abcTuneLabel(t) })),
      selectedTuneIndex: this.selectedTuneIndex,
      transposeSemitones: this.transposeSemitones,
    };
    if (!built) {
      return {
        ...common,
        summaryText: '',
        warnings: [],
        error: this.loadError,
        canStart: false,
      };
    }
    return {
      ...common,
      summaryText: abcPracticeSummary(built.tune, built.result),
      warnings: [...built.tune.warnings, ...this.fileWarnings],
      error: built.result.status === 'ok' ? undefined : built.result.message,
      canStart: built.result.status === 'ok',
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
    this.emit();
  }

  selectTune(index: number): void {
    if (!this.tunes.some((t) => t.index === index)) return;
    this.selectedTuneIndex = index;
    this.emit();
  }

  setTranspose(semitones: number): void {
    this.transposeSemitones = semitones;
    this.emit();
  }

  // --- Session lifecycle -------------------------------------------------

  /** Starts practicing the selected tune. A no-op if nothing practicable is selected. */
  start(): void {
    const built = this.build();
    if (!built || built.result.status !== 'ok') return;
    const notes: readonly SequenceNote[] = built.result.notes;
    this.runner.begin(notes);
  }

  /** "Practice another piece" -- discards the session and returns to the import screen (the imported file and selection are kept). */
  restart(): void {
    this.runner.end();
    this.emit();
  }

  giveUp(): void {
    this.runner.giveUp();
  }

  skipDrill(): void {
    this.runner.skipDrill();
  }

  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    this.runner.handleAnalysisFrame(reading, rawReading, timestampMs);
  }
}

/** A fresh controller's starting snapshot, for App.tsx's `useState` initializer (the controller itself never pushes it via `onChange`). */
export const INITIAL_ABC_PRACTICE_VIEW_STATE: AbcPracticeViewState = new AbcPracticeController(
  async () => undefined,
).getViewState();
