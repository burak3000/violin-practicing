/**
 * Playing Practice mode (Phase 6) + Drilling (Phase 7): the *configuration*
 * half -- reading the string/pattern/direction/range controls, previewing the
 * procedurally generated sequence, and starting a session from it. Running
 * the session itself (target note, live feedback, dwell bar, banners,
 * give-up/skip buttons, the Drilling hand-off) lives in
 * `./practice-session-view.ts`, which this delegates to and which ABC
 * Notation practice (`./abc-practice-ui.ts`) shares. Both are fed by the exact
 * same Phase 3 capture -> DSP pipeline as the Finger Tuner (see renderer.ts),
 * through `packages/core`'s `PracticeAttemptTracker` /
 * `PracticeSessionController` -- NOT `TunerDisplaySmoother` (that is for
 * continuous tuner display; this is discrete, single-note, dwell-and-give-up
 * scoring against a specific target, a different job, see
 * `packages/core/CLAUDE.md`).
 *
 * Like renderer.ts's own Finger Tuner code, this file only consumes the
 * pipeline's output -- it does not touch capture-pipeline.ts,
 * device-enumeration.ts, or anything under @violin/dsp-ts.
 *
 * Integration point: `PracticeSessionController`, not the bare
 * `PlayingPracticeMachine` -- it already composes Playing Practice with
 * Drilling into "the single state machine a UI actually drives".
 */

import {
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
  PracticeSessionView,
  type NoteDisplay,
  type PracticeSessionElements,
} from './practice-session-view.js';

export interface PlayingPracticeElements extends PracticeSessionElements {
  readonly configDetails: HTMLDetailsElement;
  readonly stringCheckboxes: Readonly<Record<ViolinStringName, HTMLInputElement>>;
  readonly patternSelect: HTMLSelectElement;
  readonly directionSelect: HTMLSelectElement;
  readonly minFreqInput: HTMLInputElement;
  readonly maxFreqInput: HTMLInputElement;
  readonly preview: HTMLElement;
  readonly configError: HTMLElement;
  readonly startBtn: HTMLButtonElement;
}

/**
 * Owns the Playing Practice mode's configuration controls and hands the
 * generated sequence to a `PracticeSessionView`. One instance for the app's
 * lifetime, constructed once in renderer.ts and fed every analysis hop via
 * `handleAnalysisFrame`, regardless of which mode tab is currently visible
 * (see renderer.ts's mode-switching code for why this keeps running in the
 * background rather than being torn down on tab switch: switching back to
 * this tab should not have lost its place).
 */
export class PlayingPracticeUi {
  private readonly view: PracticeSessionView;

  constructor(private readonly el: PlayingPracticeElements) {
    this.view = new PracticeSessionView(el, () => this.showConfigAgain());

    const onConfigChange = (): void => this.updatePreview();
    for (const checkbox of Object.values(this.el.stringCheckboxes)) {
      checkbox.addEventListener('change', onConfigChange);
    }
    this.el.patternSelect.addEventListener('change', onConfigChange);
    this.el.directionSelect.addEventListener('change', onConfigChange);
    this.el.minFreqInput.addEventListener('input', onConfigChange);
    this.el.maxFreqInput.addEventListener('input', onConfigChange);
    this.el.startBtn.addEventListener('click', () => this.start());

    this.updatePreview();
  }

  private readConfig(): SequenceGeneratorConfig {
    const strings: ViolinStringName[] = VIOLIN_STRING_ORDER.filter(
      (name) => this.el.stringCheckboxes[name].checked,
    );
    return {
      strings,
      patternType: this.el.patternSelect.value as SequencePatternType,
      direction: this.el.directionSelect.value as SequenceDirection,
      minFrequencyHz: Number(this.el.minFreqInput.value),
      maxFrequencyHz: Number(this.el.maxFreqInput.value),
    };
  }

  /**
   * Regenerates the sequence from the current controls and shows a live
   * count + note-label preview, or a friendly error -- run on every config
   * control change so "changing the sequence config visibly changes what
   * the generator produces" is true even before clicking Start.
   * `generatePlayingPracticeSequence` never throws on a merely
   * *unproductive* config (e.g. an inverted or absurdly narrow frequency
   * range just filters everything out); it throws `RangeError` only on a
   * structurally invalid one (no strings selected, or min > max) -- both
   * are handled here, neither crashes the UI.
   */
  private updatePreview(): void {
    let notes: readonly SequenceNote[];
    try {
      notes = generatePlayingPracticeSequence(this.readConfig());
    } catch (err) {
      this.el.preview.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    if (notes.length === 0) {
      this.el.preview.textContent = '0 notes — this configuration produces an empty sequence.';
      return;
    }
    const labels = notes.map((n) => n.note.label);
    const shown = labels.length > 8 ? `${labels.slice(0, 8).join(', ')}, …` : labels.join(', ');
    this.el.preview.textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}: ${shown}`;
  }

  private start(): void {
    this.el.configError.hidden = true;
    this.el.configError.textContent = '';

    let notes: readonly SequenceNote[];
    try {
      notes = generatePlayingPracticeSequence(this.readConfig());
    } catch (err) {
      this.el.configError.hidden = false;
      this.el.configError.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    if (notes.length === 0) {
      this.el.configError.hidden = false;
      this.el.configError.textContent =
        'This configuration produces no notes to practice — try widening the frequency range or picking a different pattern.';
      return;
    }

    this.el.configDetails.open = false;
    this.view.begin(notes);
  }

  private showConfigAgain(): void {
    this.view.end();
    this.el.configDetails.open = true;
  }

  /** Drilling on/off -- see `PracticeSessionView.setDrillingEnabled`. */
  setDrillingEnabled(enabled: boolean): void {
    this.view.setDrillingEnabled(enabled);
  }

  /** Letters vs. staff for the target note -- see `PracticeSessionView.setNoteDisplay`. */
  setNoteDisplay(display: NoteDisplay): void {
    this.view.setNoteDisplay(display);
  }

  /**
   * Feed one analysis hop's already-computed readings in. Called from
   * renderer.ts's `handleAnalysis` alongside (not instead of) the existing
   * Finger Tuner code. A no-op whenever no sequence has been started yet.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    this.view.handleAnalysisFrame(reading, rawReading, timestampMs);
  }
}
