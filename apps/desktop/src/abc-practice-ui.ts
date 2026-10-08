/**
 * ABC Notation practice mode: import an ABC file, pick a tune, and practice
 * its notes in order -- the sheet-music sibling of the scale/arpeggio-style
 * Playing Practice. Parsing and the sequence conversion live in
 * `packages/core` (`parseAbc`, `buildAbcPracticeSequence`) and are shared with
 * mobile; this file is only the desktop import/preview UI. The session itself
 * (target note, scoring, Drilling on a miss, banners, completion) is the very
 * same `PracticeSessionView` Playing Practice uses, fed an ABC-derived
 * `SequenceNote[]` instead of a generated one -- so a missed note drills that
 * note and its neighbors in the tune exactly like it does in a scale.
 *
 * Importing uses a plain `<input type="file">` read with `File.text()`: it is
 * a normal renderer-side Web API in Electron, so no main-process IPC or
 * preload bridge is needed (and nothing is persisted -- the file is parsed in
 * memory and not kept).
 *
 * Like the other mode UIs, this keeps scoring in the background while its tab
 * is hidden (renderer.ts calls `handleAnalysisFrame` on every hop).
 */

import {
  MAX_ABC_TEXT_LENGTH,
  abcPracticeSummary,
  abcTuneLabel,
  buildAbcPracticeSequence,
  parseAbc,
  type AbcTune,
  type FingerTunerReading,
  type PitchReading,
  type SequenceNote,
} from '@violin/core';
import { PracticeSessionView, type PracticeSessionElements } from './practice-session-view.js';

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
}

/** A tune book is text; refuse to even read something far bigger than `parseAbc` would accept (UTF-8 is at most 4 bytes per character). */
const MAX_ABC_FILE_BYTES = MAX_ABC_TEXT_LENGTH * 4;

export class AbcPracticeUi {
  private readonly view: PracticeSessionView;
  private tunes: readonly AbcTune[] = [];
  private fileWarnings: readonly string[] = [];
  /** The sequence the Start button will begin, or undefined if the current selection can't be practiced. */
  private ready: readonly SequenceNote[] | undefined;

  constructor(private readonly el: AbcPracticeElements) {
    this.view = new PracticeSessionView(el, () => this.showImportAgain());

    this.el.importBtn.addEventListener('click', () => this.el.fileInput.click());
    this.el.fileInput.addEventListener('change', () => void this.loadSelectedFile());
    this.el.tuneSelect.addEventListener('change', () => this.refresh());
    this.el.transposeSelect.addEventListener('change', () => this.refresh());
    this.el.startBtn.addEventListener('click', () => this.start());

    this.el.startBtn.disabled = true;
  }

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
    this.el.startBtn.disabled = true;
  }

  private selectedTune(): AbcTune | undefined {
    return this.tunes.find((t) => String(t.index) === this.el.tuneSelect.value);
  }

  /** Recomputes the preview/warnings/Start state for the selected tune and transposition. */
  private refresh(): void {
    const tune = this.selectedTune();
    this.ready = undefined;
    this.el.startBtn.disabled = true;
    this.el.error.hidden = true;
    this.el.error.textContent = '';
    if (!tune) return;

    const built = buildAbcPracticeSequence(tune, {
      transposeSemitones: Number(this.el.transposeSelect.value),
    });

    this.el.summary.textContent = abcPracticeSummary(tune, built);
    if (built.status === 'ok') {
      this.ready = built.notes;
      this.el.startBtn.disabled = false;
    } else {
      this.el.error.hidden = false;
      this.el.error.textContent = built.message;
    }

    this.el.warnings.replaceChildren(
      ...[...tune.warnings, ...this.fileWarnings].map((message) => {
        const li = document.createElement('li');
        li.textContent = message;
        return li;
      }),
    );
  }

  private start(): void {
    if (!this.ready) return;
    this.el.configDetails.open = false;
    this.view.begin(this.ready);
  }

  private showImportAgain(): void {
    this.view.end();
    this.el.configDetails.open = true;
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * renderer.ts's `handleAnalysisFrame` alongside the other modes. A no-op
   * whenever no ABC session has been started.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    this.view.handleAnalysisFrame(reading, rawReading, timestampMs);
  }
}
