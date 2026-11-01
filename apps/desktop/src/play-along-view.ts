/**
 * The timed play-along's session screen (ABC Notation mode, "Play along"):
 * everything the player looks at while a metronome clicks and the piece moves
 * on the beat -- the tempo and beat dots, the count-in number and "Play!" cue,
 * the sheet music with a moving playhead (or the big note name), the live
 * "Hearing ..." line, and, once the run ends, the results card.
 *
 * It draws; it does not decide. `packages/core`'s `PlayAlongRunner` owns the
 * clock, the click scheduling, the scoring and the wording (`getView()` is the
 * whole render model), and this class only
 *
 *  - forwards each analysis frame to the runner (`handleAnalysisFrame`, the
 *    same hop the other modes get; no drawing happens there, so the per-frame
 *    path stays cheap), and
 *  - paints `runner.getView()` on every animation frame while a run is active.
 *
 * ## Why the screen is driven by animation frames, not by analysis frames
 *
 * The count-in and the playhead must move even if the audio stream is stalled
 * (the runner derives the display from the platform clock for exactly that
 * reason), and a stalled stream must be *visible* (`signalLost`), not a frozen
 * screen. So the paint loop is independent of the analysis callback.
 *
 * ## Per-frame cost
 *
 * Nothing here rebuilds the score every frame. The SVG is rebuilt only when
 * the first bar of the window changes or the window resizes (`ScoreView`),
 * note colours change only when the runner reports a new
 * `noteStatesVersion`, and the playhead is one `transform` write. Text is
 * written only when it changed.
 */

import {
  describeFinger,
  fingerMarkFor,
  fingerMarksOf,
  type FingerTunerReading,
  type PitchReading,
  type PlayAlongRunner,
  type PlayAlongRunView,
  type PlayAlongSummaryView,
} from '@violin/core';
import type { NoteDisplay } from './practice-session-view.js';
import { ScoreView } from './score-view.js';

/** How long the "Play!" cue stays up after the music starts. */
const PLAY_CUE_MS = 900;

/** The score shows at least this many bars (the current one and the next), shrinking the notation if it must: a player reads ahead. */
const READ_AHEAD_BARS = 2;

export interface PlayAlongViewElements {
  readonly root: HTMLElement;
  readonly tempo: HTMLElement;
  /** Container the beat dots are built into. */
  readonly beats: HTMLElement;
  readonly progress: HTMLElement;
  readonly stopBtn: HTMLButtonElement;
  /** A small note under the header (e.g. "Metronome click unavailable ..."). */
  readonly notice: HTMLElement;
  readonly cue: HTMLElement;
  /** Wraps everything shown while playing; hidden once the run has ended. */
  readonly stage: HTMLElement;
  readonly score: HTMLElement;
  readonly letters: HTMLElement;
  readonly target: HTMLElement;
  /** The finger for the note shown in `target` ("Finger 2", "Open string"); stays empty when finger numbers are off. */
  readonly finger: HTMLElement;
  readonly next: HTMLElement;
  readonly signalLost: HTMLElement;
  readonly liveFeedback: HTMLElement;
  readonly dwellFill: HTMLElement;
  readonly results: HTMLElement;
  readonly resultsHeadline: HTMLElement;
  readonly resultsTendency: HTMLElement;
  readonly resultsMisses: HTMLUListElement;
  readonly resultsNoMisses: HTMLElement;
  readonly playAgainBtn: HTMLButtonElement;
  readonly practiceMissedBtn: HTMLButtonElement;
  readonly changeSettingsBtn: HTMLButtonElement;
}

export interface PlayAlongViewActions {
  /** The run ended (completed, or stopped): the owner should silence any click still queued. */
  onRunEnded(): void;
  onPlayAgain(): void;
  /** Start an untimed Wait-for-me session over just the notes the player missed. */
  onPracticeMissed(noteIndices: readonly number[]): void;
  onChangeSettings(): void;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export class PlayAlongView {
  private runner: PlayAlongRunner | undefined;
  private scoreView: ScoreView | undefined;
  private frameHandle: number | undefined;
  private noteDisplay: NoteDisplay = 'letters';
  private ended = false;

  private dots: HTMLElement[] = [];
  private litDot = -1;
  private showFingers = false;

  /** Shows or hides finger numbers right now (the score redraws on the next frame). */
  setFingersEnabled(on: boolean): void {
    this.showFingers = on;
    if (this.runner)
      this.scoreView?.setFingers(on ? fingerMarksOf(this.runner.piece.notes) : undefined);
  }

  private statesVersion = -1;
  private lastDwellPercent = -1;

  constructor(
    private readonly el: PlayAlongViewElements,
    private readonly actions: PlayAlongViewActions,
  ) {
    this.el.stopBtn.addEventListener('click', () => {
      this.runner?.stop();
      this.finishIfNeeded();
    });
    this.el.playAgainBtn.addEventListener('click', () => this.actions.onPlayAgain());
    this.el.changeSettingsBtn.addEventListener('click', () => this.actions.onChangeSettings());
    this.el.practiceMissedBtn.addEventListener('click', () => {
      const indices = this.runner?.getView().summary?.missedNoteIndices ?? [];
      if (indices.length > 0) this.actions.onPracticeMissed(indices);
    });
  }

  /**
   * Shows the screen for `runner` and starts the run. `notice` is an optional
   * small line under the header (used to say the click is unavailable).
   */
  begin(
    runner: PlayAlongRunner,
    notice?: string,
    options: { readonly fingers?: boolean } = {},
  ): void {
    this.end();
    this.runner = runner;
    this.ended = false;
    this.showFingers = options.fingers === true;
    this.scoreView = new ScoreView(this.el.score, runner.piece);
    if (this.showFingers) this.scoreView.setFingers(fingerMarksOf(runner.piece.notes));
    this.statesVersion = -1;
    this.lastDwellPercent = -1;

    this.el.root.hidden = false;
    this.el.stage.hidden = false;
    this.el.cue.hidden = false;
    this.el.results.hidden = true;
    this.el.stopBtn.hidden = false;
    this.el.beats.hidden = false;
    this.el.signalLost.hidden = true;
    this.el.liveFeedback.textContent = '';
    this.el.dwellFill.style.width = '0%';
    this.el.notice.hidden = notice === undefined;
    this.el.notice.textContent = notice ?? '';
    this.buildDots(runner.piece.meter.beatsPerBar);
    this.applyDisplay();

    runner.start();
    this.render();
    this.scheduleFrame();
  }

  /** Discards the run (stopping it if it is still going) and hides the screen. */
  end(): void {
    this.cancelFrame();
    const runner = this.runner;
    this.runner = undefined;
    if (runner && !this.ended) {
      runner.stop();
      this.actions.onRunEnded();
    }
    this.ended = false;
    this.scoreView?.clear();
    this.scoreView = undefined;
    this.el.root.hidden = true;
    this.el.results.hidden = true;
  }

  /** Letters (big note name) vs. staff (sheet music with a playhead). Safe to call at any time. */
  setNoteDisplay(display: NoteDisplay): void {
    this.noteDisplay = display;
    this.applyDisplay();
    if (this.runner && !this.ended) this.render();
  }

  private applyDisplay(): void {
    const showScore = this.noteDisplay === 'staff';
    this.el.score.hidden = !showScore;
    this.el.letters.hidden = showScore;
  }

  /**
   * Feed one analysis hop in (renderer.ts calls this on every hop, whichever
   * tab is showing). Only scoring happens here; painting is the animation
   * loop's job.
   */
  handleAnalysisFrame(
    reading: PitchReading,
    rawReading: FingerTunerReading,
    timestampMs: number,
  ): void {
    const runner = this.runner;
    if (!runner || this.ended) return;
    runner.handleFrame(reading, rawReading, timestampMs);
    if (runner.phase === 'finished') this.finishIfNeeded();
  }

  // --- Animation loop ------------------------------------------------------------

  private scheduleFrame(): void {
    if (this.frameHandle !== undefined) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = undefined;
      if (!this.runner || this.ended) return;
      this.render();
      this.finishIfNeeded();
      if (this.runner && !this.ended) this.scheduleFrame();
    });
  }

  private cancelFrame(): void {
    if (this.frameHandle !== undefined) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  /** Notices (once) that the runner has ended -- by completion or Stop -- and swaps the playing screen for the results. */
  private finishIfNeeded(): void {
    const runner = this.runner;
    if (!runner || this.ended || runner.phase !== 'finished') return;
    this.ended = true;
    this.cancelFrame();
    this.actions.onRunEnded();
    this.render();
  }

  // --- Painting ------------------------------------------------------------------

  private buildDots(count: number): void {
    this.dots = [];
    this.litDot = -1;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) fragment.append(this.makeDot(i));
    this.el.beats.replaceChildren(fragment);
  }

  private makeDot(index: number): HTMLElement {
    const dot = document.createElement('span');
    dot.className = index === 0 ? 'pa-beat pa-beat-accent' : 'pa-beat';
    this.dots[index] = dot;
    return dot;
  }

  private render(): void {
    const runner = this.runner;
    if (!runner) return;
    const view = runner.getView();
    this.el.root.dataset.phase = view.phase;

    setText(this.el.tempo, view.tempoText);

    if (view.phase === 'finished') {
      setText(this.el.progress, runner.completed ? 'Finished' : 'Stopped');
      this.el.stopBtn.hidden = true;
      this.el.beats.hidden = true;
      this.el.stage.hidden = true;
      this.el.cue.hidden = true;
      if (view.summary) this.showResults(view.summary);
      return;
    }

    setText(this.el.progress, view.progressText);
    this.renderBeats(view);
    this.renderCue(view);
    if (this.noteDisplay === 'staff') this.renderScore(view);
    else this.renderLetters(view);

    this.el.signalLost.hidden = !view.signalLost;
    setText(this.el.liveFeedback, view.signalLost ? '' : view.liveFeedbackText);
    const percent = Math.round(view.dwellFraction * 100);
    if (percent !== this.lastDwellPercent) {
      this.lastDwellPercent = percent;
      this.el.dwellFill.style.width = `${percent}%`;
    }
  }

  private renderBeats(view: PlayAlongRunView): void {
    const beat = view.beat;
    const lit = beat ? beat.inBar - 1 : -1;
    // A meter change can raise the number of beats in a bar: grow the row, never shrink it mid-run.
    while (lit >= this.dots.length) this.el.beats.append(this.makeDot(this.dots.length));
    if (lit !== this.litDot) {
      this.dots[this.litDot]?.classList.remove('pa-beat-lit');
      this.dots[this.litDot]?.style.removeProperty('--pulse');
      this.dots[lit]?.classList.add('pa-beat-lit');
      this.litDot = lit;
    }
    if (beat) this.dots[lit]?.style.setProperty('--pulse', (1 - beat.progress).toFixed(2));
  }

  private renderCue(view: PlayAlongRunView): void {
    let text = '';
    let kind = '';
    if (view.phase === 'count-in') {
      // Nothing has clicked yet (the short lead-in, or no count-in at all): don't show a number early.
      if (
        view.beat === undefined ||
        view.countInRemaining === undefined ||
        view.countInRemaining < 1
      ) {
        text = 'Get ready…';
        kind = 'ready';
      } else {
        text = String(view.countInRemaining);
        kind = 'count';
      }
    } else if (view.phase === 'playing' && view.timeMs < PLAY_CUE_MS) {
      text = 'Play!';
      kind = 'play';
    }
    setText(this.el.cue, text);
    if (kind === '') delete this.el.cue.dataset.kind;
    else this.el.cue.dataset.kind = kind;
  }

  private renderScore(view: PlayAlongRunView): void {
    const scoreView = this.scoreView;
    if (!scoreView) return;
    // The window starts at the bar being played (bar 0 during the count-in, when the position is negative).
    const rebuilt = scoreView.show(scoreView.barAt(view.positionWhole), READ_AHEAD_BARS);
    if (rebuilt || view.noteStatesVersion !== this.statesVersion) {
      this.statesVersion = view.noteStatesVersion;
      scoreView.applyStates((noteIndex) => view.noteStates[noteIndex] ?? 'pending');
    }
    scoreView.setPlayhead(view.positionWhole, view.phase === 'count-in');
  }

  private renderLetters(view: PlayAlongRunView): void {
    setText(this.el.target, view.targetLabel === '' ? '—' : view.targetLabel);
    // The big name takes the colour of how the note it shows is going.
    const state = view.dueNoteIndex === undefined ? undefined : view.noteStates[view.dueNoteIndex];
    if (state === undefined || state === 'pending') delete this.el.target.dataset.state;
    else this.el.target.dataset.state = state;
    const note =
      view.targetNoteIndex === undefined || !this.runner
        ? undefined
        : this.runner.piece.notes[view.targetNoteIndex];
    const mark = this.showFingers && note ? fingerMarkFor(note) : undefined;
    setText(this.el.finger, describeFinger(mark));
    if (mark) this.el.finger.dataset.source = mark.source;
    else delete this.el.finger.dataset.source;
    setText(
      this.el.next,
      view.upcomingLabels.length > 0 ? `Next: ${view.upcomingLabels.join(' ')}` : '',
    );
  }

  private showResults(summary: PlayAlongSummaryView): void {
    if (!this.el.results.hidden) return;
    setText(this.el.resultsHeadline, summary.headline);
    setText(this.el.resultsTendency, summary.tendency ?? '');
    this.el.resultsTendency.hidden = summary.tendency === undefined;

    this.el.resultsMisses.replaceChildren(
      ...summary.misses.map((miss) => {
        const item = document.createElement('li');
        item.textContent = miss.text;
        return item;
      }),
    );
    this.el.resultsMisses.hidden = summary.misses.length === 0;
    this.el.resultsNoMisses.hidden = summary.misses.length > 0;
    this.el.resultsNoMisses.textContent =
      summary.total === 0
        ? ''
        : summary.complete
          ? 'No missed notes -- every note was in tune and on time.'
          : 'No missed notes before you stopped.';
    this.el.practiceMissedBtn.hidden = summary.missedNoteIndices.length === 0;

    this.el.results.hidden = false;
    // The Stop button the user may have just pressed is gone; put focus on the card so a screen reader reads it and keyboard users are not left on <body>.
    this.el.results.focus({ preventScroll: true });
  }
}
