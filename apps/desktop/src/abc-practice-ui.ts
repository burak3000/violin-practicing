/**
 * ABC Notation practice mode: import an ABC file, pick a tune, and practice
 * its notes -- the sheet-music sibling of the scale/arpeggio-style Playing
 * Practice. Parsing and the sequence conversion live in `packages/core`
 * (`parseAbc`, `buildAbcPracticeSequence`) and are shared with mobile; this
 * file is the desktop import/preview/settings UI and the hand-off to one of two
 * practice styles:
 *
 *  - **Play along** (default): a timed run. A metronome clicks at the tempo, the
 *    piece advances on the beat, and every note must be in tune *and* on time;
 *    the missed ones are listed at the end. `packages/core`'s `PlayAlongRunner`
 *    does the clock, scoring and wording; `play-along-view.ts` paints it. No
 *    Drilling here -- the clock cannot stop for it.
 *  - **Wait for me**: the original untimed flow. The session is the very same
 *    `PracticeSessionView` Playing Practice uses, fed the ABC-derived
 *    `SequenceNote[]`, so a missed note drills that note and its neighbors in
 *    the tune exactly like it does in a scale. It is also where "practice the
 *    notes I missed" runs.
 *
 * ## Tempo is UI state, never the file
 *
 * The tempo (and the beat unit it is counted in) is read from the file when a
 * piece is chosen, shown here, and adjustable without ever being written back:
 * the file is parsed in memory and not even kept. Choosing another file, tune or
 * transposition resets the tempo to the written one.
 *
 * Importing uses a plain `<input type="file">` read with `File.text()`: it is
 * a normal renderer-side Web API in Electron, so no main-process IPC or
 * preload bridge is needed.
 *
 * Like the other mode UIs, this keeps scoring in the background while its tab
 * is hidden (renderer.ts calls `handleAnalysisFrame` on every hop).
 */

import {
  MAX_ABC_TEXT_LENGTH,
  MAX_TEMPO_BPM,
  MIN_TEMPO_BPM,
  PlayAlongRunner,
  abcPracticeSummary,
  abcTuneLabel,
  buildAbcPracticeSequence,
  clampTempoBpm,
  countInBeatsForBars,
  describeTempoSettings,
  formatTempoMark,
  notesAtIndices,
  parseAbc,
  type AbcPiece,
  type AbcTune,
  type FingerTunerReading,
  type PitchReading,
  type SequenceNote,
} from '@violin/core';
import { Metronome } from './audio/metronome.js';
import { PlayAlongView, type PlayAlongViewElements } from './play-along-view.js';
import {
  PracticeSessionView,
  type NoteDisplay,
  type PracticeSessionElements,
} from './practice-session-view.js';

export type AbcPracticeStyle = 'play-along' | 'wait';

export interface AbcTempoElements {
  /** The unit symbol in front of the number ("♩"). */
  readonly unit: HTMLElement;
  readonly input: HTMLInputElement;
  readonly slider: HTMLInputElement;
  readonly minus: HTMLButtonElement;
  readonly plus: HTMLButtonElement;
  readonly reset: HTMLButtonElement;
  readonly hint: HTMLElement;
}

export interface AbcPracticeElements extends PracticeSessionElements {
  readonly configDetails: HTMLDetailsElement;
  readonly importBtn: HTMLButtonElement;
  readonly fileInput: HTMLInputElement;
  readonly fileName: HTMLElement;
  /** Wrapper around `tuneSelect`, hidden unless the file holds more than one tune. */
  readonly tuneField: HTMLElement;
  readonly tuneSelect: HTMLSelectElement;
  /** Option values are semitone shifts (-24, -12, 0, 12, 24). */
  readonly transposeSelect: HTMLSelectElement;
  readonly summary: HTMLElement;
  readonly warnings: HTMLUListElement;
  readonly error: HTMLElement;
  readonly startBtn: HTMLButtonElement;
  readonly playAlongStyleBtn: HTMLButtonElement;
  readonly waitStyleBtn: HTMLButtonElement;
  readonly styleHint: HTMLElement;
  /** The play-along settings (tempo, count-in, click): hidden for "Wait for me", disabled until a piece is ready. */
  readonly playAlongOptions: HTMLFieldSetElement;
  readonly tempo: AbcTempoElements;
  /** Option values are bars of count-in (1, 2, 0). */
  readonly countInSelect: HTMLSelectElement;
  readonly clickCheckbox: HTMLInputElement;
  readonly playAlong: PlayAlongViewElements;
}

/** A tune book is text; refuse to even read something far bigger than `parseAbc` would accept (UTF-8 is at most 4 bytes per character). */
const MAX_ABC_FILE_BYTES = MAX_ABC_TEXT_LENGTH * 4;

const STYLE_HINTS: Readonly<Record<AbcPracticeStyle, string>> = {
  'play-along':
    'A metronome clicks and the piece moves on with the beat. Each note has to be in tune and on time; the notes you miss are listed at the end.',
  wait: 'The app waits for you. Play each note in tune and it moves on; a note you cannot get is drilled with its neighbours.',
};

const START_LABELS: Readonly<Record<AbcPracticeStyle, string>> = {
  'play-along': 'Start play-along',
  wait: 'Start practicing',
};

/** What a run was started with, so "Play again" repeats it exactly. */
interface PlayAlongSettings {
  readonly piece: AbcPiece;
  readonly tempoBpm: number;
  readonly countInBeats: number;
  readonly click: boolean;
}

export class AbcPracticeUi {
  private readonly view: PracticeSessionView;
  private readonly playAlong: PlayAlongView;
  private readonly metronome = new Metronome(() => Date.now());

  private tunes: readonly AbcTune[] = [];
  private fileWarnings: readonly string[] = [];
  /** The piece (and its practice sequence) the Start button will begin, or undefined if the current selection can't be practiced. */
  private ready: { readonly notes: readonly SequenceNote[]; readonly piece: AbcPiece } | undefined;
  private style: AbcPracticeStyle = 'play-along';
  /** The tempo chosen in the UI, in beats per minute of the piece's own tempo beat. */
  private tempoBpm = 80;
  /** True from pressing Start until the run is on screen (the click's audio context may take a moment): ignores a second press. */
  private starting = false;
  private lastRun: PlayAlongSettings | undefined;

  constructor(private readonly el: AbcPracticeElements) {
    this.view = new PracticeSessionView(el, () => this.showImportAgain());
    this.playAlong = new PlayAlongView(el.playAlong, {
      onRunEnded: () => this.metronome.cancelPending(),
      onPlayAgain: () => {
        if (this.lastRun) void this.startPlayAlong(this.lastRun);
      },
      onPracticeMissed: (indices) => this.practiceMissed(indices),
      onChangeSettings: () => this.showSettingsAgain(),
    });

    this.el.importBtn.addEventListener('click', () => this.el.fileInput.click());
    this.el.fileInput.addEventListener('change', () => void this.loadSelectedFile());
    this.el.tuneSelect.addEventListener('change', () => this.refresh());
    this.el.transposeSelect.addEventListener('change', () => this.refresh());
    this.el.startBtn.addEventListener('click', () => this.start());

    this.el.playAlongStyleBtn.addEventListener('click', () => this.setStyle('play-along'));
    this.el.waitStyleBtn.addEventListener('click', () => this.setStyle('wait'));

    const tempo = this.el.tempo;
    tempo.input.min = String(MIN_TEMPO_BPM);
    tempo.input.max = String(MAX_TEMPO_BPM);
    // While typing, follow every valid value but leave the text alone (clearing the field to type a new number must not snap it back); settle on blur/Enter.
    tempo.input.addEventListener('input', () => {
      const typed = tempo.input.value.trim();
      const value = Number(typed);
      if (
        typed !== '' &&
        Number.isFinite(value) &&
        value >= MIN_TEMPO_BPM &&
        value <= MAX_TEMPO_BPM
      ) {
        this.tempoBpm = Math.round(value);
        this.syncTempoControls(false);
      }
    });
    tempo.input.addEventListener('change', () => this.commitTempoInput());
    tempo.minus.addEventListener('click', () => this.setTempo(this.tempoBpm - 1));
    tempo.plus.addEventListener('click', () => this.setTempo(this.tempoBpm + 1));
    tempo.slider.addEventListener('input', () => this.setTempo(Number(tempo.slider.value)));
    tempo.reset.addEventListener('click', () => {
      if (this.ready) this.setTempo(this.writtenTempo(this.ready.piece));
    });

    this.el.startBtn.disabled = true;
    this.setStyle('play-along');
  }

  // --- Import ----------------------------------------------------------------

  private async loadSelectedFile(): Promise<void> {
    const file = this.el.fileInput.files?.[0];
    // Clear the input so choosing the same file again (e.g. after editing it) fires `change` again.
    this.el.fileInput.value = '';
    if (!file) return;

    this.el.fileName.textContent = file.name;
    if (file.size > MAX_ABC_FILE_BYTES) {
      this.showLoadError(`"${file.name}" is too large to be an ABC file.`);
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      this.showLoadError(
        `Could not read "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const result = parseAbc(text);
    this.tunes = result.tunes;
    this.fileWarnings = result.warnings;
    if (result.tunes.length === 0) {
      this.showLoadError(result.warnings.join(' '));
      return;
    }

    this.el.tuneSelect.innerHTML = '';
    for (const tune of result.tunes) {
      const option = document.createElement('option');
      option.value = String(tune.index);
      option.textContent = abcTuneLabel(tune);
      this.el.tuneSelect.appendChild(option);
    }
    const firstWithNotes = result.tunes.find((t) => t.voices.some((v) => v.notes.length > 0));
    this.el.tuneSelect.value = String((firstWithNotes ?? result.tunes[0]!).index);
    this.el.tuneField.hidden = result.tunes.length < 2;
    this.el.transposeSelect.value = '0';
    this.refresh();
  }

  private showLoadError(message: string): void {
    this.tunes = [];
    this.fileWarnings = [];
    this.ready = undefined;
    this.el.tuneField.hidden = true;
    this.el.summary.textContent = '';
    this.el.warnings.replaceChildren();
    this.el.error.hidden = false;
    this.el.error.textContent = message;
    this.refreshStartState();
  }

  private selectedTune(): AbcTune | undefined {
    return this.tunes.find((t) => String(t.index) === this.el.tuneSelect.value);
  }

  /** Recomputes the preview/warnings/tempo/Start state for the selected tune and transposition. */
  private refresh(): void {
    const tune = this.selectedTune();
    this.ready = undefined;
    this.el.error.hidden = true;
    this.el.error.textContent = '';
    if (!tune) {
      this.refreshStartState();
      return;
    }

    const built = buildAbcPracticeSequence(tune, {
      transposeSemitones: Number(this.el.transposeSelect.value),
    });

    let summary = abcPracticeSummary(tune, built);
    if (built.status === 'ok') {
      this.ready = { notes: built.notes, piece: built.piece };
      // The core summary already names the meter; the tempo is shown when the file actually gives one.
      if (built.piece.tempoSource === 'file') {
        const tempoPart = ` · ${formatTempoMark(built.piece.tempo)}`;
        const newline = summary.indexOf('\n');
        summary =
          newline === -1
            ? summary + tempoPart
            : summary.slice(0, newline) + tempoPart + summary.slice(newline);
      }
      this.resetTempoFor(built.piece);
    } else {
      this.el.error.hidden = false;
      this.el.error.textContent = built.message;
    }
    this.el.summary.textContent = summary;

    this.el.warnings.replaceChildren(
      ...[...tune.warnings, ...this.fileWarnings].map((message) => {
        const li = document.createElement('li');
        li.textContent = message;
        return li;
      }),
    );
    this.refreshStartState();
  }

  private refreshStartState(): void {
    this.el.startBtn.disabled = this.ready === undefined || this.starting;
    this.el.playAlongOptions.disabled = this.ready === undefined;
    if (this.ready === undefined) this.el.tempo.reset.hidden = true;
  }

  // --- Practice style ----------------------------------------------------------

  private setStyle(style: AbcPracticeStyle): void {
    this.style = style;
    this.el.playAlongStyleBtn.setAttribute('aria-pressed', String(style === 'play-along'));
    this.el.waitStyleBtn.setAttribute('aria-pressed', String(style === 'wait'));
    this.el.styleHint.textContent = STYLE_HINTS[style];
    this.el.playAlongOptions.hidden = style !== 'play-along';
    this.el.startBtn.textContent = START_LABELS[style];
  }

  // --- Tempo -------------------------------------------------------------------

  /** The written tempo as the number field can hold it (a file's `Q:` may be fractional or out of range). */
  private writtenTempo(piece: AbcPiece): number {
    return clampTempoBpm(piece.tempo.bpm);
  }

  /** Back to the file's tempo: the unit, the slider's range and the number all follow the new piece. */
  private resetTempoFor(piece: AbcPiece): void {
    const tempo = this.el.tempo;
    const settings = describeTempoSettings(piece, this.writtenTempo(piece));
    tempo.slider.min = String(settings.sliderMin);
    tempo.slider.max = String(settings.sliderMax);
    tempo.unit.textContent = settings.unitSymbol;
    this.tempoBpm = settings.writtenBpm;
    this.syncTempoControls(true);
  }

  private setTempo(value: number): void {
    if (!Number.isFinite(value)) return;
    this.tempoBpm = clampTempoBpm(value);
    this.syncTempoControls(true);
  }

  /** Settles a typed value: clamps it into range (an empty or nonsense field goes back to the current tempo). */
  private commitTempoInput(): void {
    const value = Number(this.el.tempo.input.value);
    if (this.el.tempo.input.value.trim() !== '' && Number.isFinite(value)) {
      this.tempoBpm = clampTempoBpm(value);
    }
    this.syncTempoControls(true);
  }

  /** Writes `tempoBpm` into the controls (`rewriteInput`: also the number field, which is left alone while the user is typing in it). */
  private syncTempoControls(rewriteInput: boolean): void {
    const tempo = this.el.tempo;
    if (rewriteInput) tempo.input.value = String(this.tempoBpm);
    tempo.slider.value = String(this.tempoBpm);

    const piece = this.ready?.piece;
    if (!piece) {
      tempo.hint.textContent = '';
      tempo.reset.hidden = true;
      return;
    }
    const settings = describeTempoSettings(piece, this.tempoBpm);
    tempo.hint.textContent = settings.hints.join(' ');
    tempo.reset.hidden = !settings.differs;
    if (settings.differs) {
      const kind = piece.tempoSource === 'file' ? 'written' : 'default';
      tempo.reset.textContent = `Reset to ${kind} tempo (${settings.writtenText})`;
    }
  }

  /** The tempo handed to the runner: exactly the file's own when the field still shows it (so a `Q:` of 92.5 plays at 92.5, not 92). */
  private effectiveTempo(piece: AbcPiece): number {
    return this.tempoBpm === this.writtenTempo(piece) ? piece.tempo.bpm : this.tempoBpm;
  }

  // --- Starting a run -------------------------------------------------------------

  private start(): void {
    const ready = this.ready;
    if (!ready || this.starting) return;
    this.commitTempoInput();
    this.el.error.hidden = true;
    this.el.configDetails.open = false;

    if (this.style === 'wait') {
      this.playAlong.end();
      this.view.begin(ready.notes, ready.piece, { fingers: this.fingersOn });
      return;
    }
    const bars = Number(this.el.countInSelect.value);
    void this.startPlayAlong({
      piece: ready.piece,
      tempoBpm: this.effectiveTempo(ready.piece),
      countInBeats: countInBeatsForBars(ready.piece, bars),
      click: this.el.clickCheckbox.checked,
    });
  }

  /**
   * Begins a timed run. The audio context is prepared first (this runs inside
   * the Start click's user gesture, which browsers require before they will
   * make a sound) and *awaited before the run starts*, so the first click is
   * never lost to the engine waking up. If audio is unavailable or slow, the
   * run goes ahead silently on the visual beat and says so.
   */
  private async startPlayAlong(settings: PlayAlongSettings): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.refreshStartState();
    try {
      this.view.end();
      this.playAlong.end();
      this.lastRun = settings;

      let clickOn = false;
      let notice: string | undefined;
      if (settings.click) {
        clickOn = await this.metronome.prepare();
        if (!clickOn) {
          notice = 'The metronome click is unavailable (no audio output) -- follow the beat dots.';
        }
      }

      const runner = new PlayAlongRunner({
        piece: settings.piece,
        tempoBpm: settings.tempoBpm,
        countInBeats: settings.countInBeats,
        nowMs: () => Date.now(),
        ...(clickOn
          ? { click: (atMs: number, accent: boolean) => this.metronome.click(atMs, accent) }
          : {}),
        // What the player hears lags what is scheduled by the output latency; scoring shifts by the same amount.
        config: { extraLatencyMs: clickOn ? this.metronome.outputLatencyMs : 0 },
      });
      this.playAlong.begin(runner, notice, { fingers: this.fingersOn });
    } catch (err) {
      this.el.error.hidden = false;
      this.el.error.textContent = `Could not start the play-along: ${err instanceof Error ? err.message : String(err)}`;
      this.el.configDetails.open = true;
    } finally {
      this.starting = false;
      this.refreshStartState();
    }
  }

  // --- Leaving a session -------------------------------------------------------------

  private showImportAgain(): void {
    this.view.end();
    this.el.configDetails.open = true;
  }

  private showSettingsAgain(): void {
    this.playAlong.end();
    this.el.configDetails.open = true;
  }

  /** From the results card: an untimed Wait-for-me session over just the notes that were missed. */
  private practiceMissed(noteIndices: readonly number[]): void {
    const run = this.lastRun;
    if (!run) return;
    const notes = notesAtIndices(run.piece, noteIndices);
    if (notes.length === 0) return;
    this.playAlong.end();
    // The piece is passed for its spelling (B♭, not A#); `score: false` keeps the plain single-note staff, since the bars in between are being skipped.
    this.view.begin(notes, run.piece, {
      score: false,
      fingers: this.fingersOn,
    });
  }

  /** Finger numbers on the score and under the note name (the bar's checkbox); applies at once, mid-session included. */
  private fingersOn = true;

  setFingersEnabled(on: boolean): void {
    this.fingersOn = on;
    this.view.setFingersEnabled(on);
    this.playAlong.setFingersEnabled(on);
  }

  /** Drilling on/off for Wait for me (the play-along never drills) -- see `PracticeSessionView.setDrillingEnabled`. */
  setDrillingEnabled(enabled: boolean): void {
    this.view.setDrillingEnabled(enabled);
  }

  /** Letters vs. staff for the target note -- see `PracticeSessionView.setNoteDisplay`. */
  setNoteDisplay(display: NoteDisplay): void {
    this.view.setNoteDisplay(display);
    this.playAlong.setNoteDisplay(display);
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * renderer.ts's `handleAnalysisFrame` alongside the other modes. A no-op
   * whenever no ABC session has been started. `timestampMs` is the worklet's
   * `Date.now()` stamp -- the same clock the play-along runner reads.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    this.view.handleAnalysisFrame(reading, rawReading, timestampMs);
    this.playAlong.handleAnalysisFrame(reading, rawReading, timestampMs);
  }
}
