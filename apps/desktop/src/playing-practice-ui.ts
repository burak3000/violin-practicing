/**
 * Phase 6 Playing Practice UI: procedural-sequence-driven single-note
 * scoring, fed by the exact same Phase 3 capture -> DSP pipeline as the
 * Finger Tuner (see renderer.ts) -- but through `packages/core`'s
 * `PracticeAttemptTracker` (Phase 6's new shared helper), not
 * `analyzeTunerReading`'s raw output and NOT `TunerDisplaySmoother` (that
 * class is for continuous tuner display; this is discrete, single-note,
 * dwell-and-give-up scoring against a specific target -- a different job,
 * see `packages/core/CLAUDE.md`).
 *
 * This file only consumes the pipeline's output (a `PitchReading` +
 * `FingerTunerReading` computed once per hop in renderer.ts, reused here)
 * -- like renderer.ts's own Finger Tuner code, it does not touch
 * capture-pipeline.ts, device-enumeration.ts, or anything under
 * @violin/dsp-ts.
 *
 * ## Integration point: PracticeSessionController, not the bare
 * PlayingPracticeMachine
 *
 * `packages/core`'s `PracticeSessionController` already composes
 * `PlayingPracticeMachine` + `DrillingMachine` into "the single state
 * machine a UI actually drives" (its own doc comment) -- wiring that in now
 * means Phase 7 (real Drilling UI) only has to change what this file
 * renders for `state.mode === 'drilling'`, not replace the integration
 * itself.
 *
 * ## Drilling UI (Phase 7) -- real, not a placeholder anymore
 *
 * Phase 6 deliberately left `controller.state.mode === 'drilling'` as a
 * minimal, honest placeholder (see `apps/desktop/CLAUDE.md`'s "Playing
 * Practice UI (Phase 6)" section for exactly what that looked like). This
 * phase replaces it with a real Drilling UI, entirely in this file plus
 * additive `index.html`/`index.css` markup -- `DrillingMachine` itself
 * (packages/core, Phase 2) is untouched; this is UI wiring on top of
 * already-implemented, already-tested domain logic, per this phase's scope.
 *
 * **Reused, not re-derived, from Playing Practice's own attempt scoring:**
 * the live "Hearing X (+Nc from target)" feedback line and the dwell-progress
 * bar are the exact same elements/formatting/`PracticeAttemptTracker` update
 * path Playing Practice already uses -- `renderCurrentState()` no longer
 * hides them for `isDrilling`, and `applyResult()`'s `'in-progress'` branch
 * no longer skips the dwell-fill update while drilling. A drill rep gets the
 * identical "am I close, how long have I held it" feedback a normal
 * target-note attempt gets, from the same code path, not a parallel copy.
 *
 * **Progress indicator**: reuses `#pp-progress` (Playing Practice's own
 * "Note X of Y" line) rather than adding a second, parallel progress
 * element -- `renderCurrentState()` just gives it different text while
 * drilling (`formatDrillProgress()`): "N of M correct in a row" from
 * `consecutiveCorrect`/`requiredConsecutiveCorrect`, plus "attempt A of B"
 * from `attemptsUsed`/`maxAttempts` (1-indexed for display -- see that
 * function's own comment on why).
 *
 * **Which pool note is active, as the pool rotates**: a documented judgment
 * call, not an oversight -- `DrillPoolNote.role` (`'neighbor-below' |
 * 'center' | 'neighbor-above'`) is NOT surfaced as a small "(neighbor
 * below)"-style label. `PracticeSessionController.state`'s `'drilling'`
 * variant only exposes `targetNote: SequenceNote` (no `role`), by design --
 * see `packages/core/src/practice/practice-session-controller.ts`. Widening
 * that public shape to add `targetNoteRole` would be a small, additive,
 * non-breaking change, but it's still a modification to a composed,
 * already-tested `packages/core` state machine, which this phase's own
 * instructions say to avoid without stopping to explain first -- and the
 * same instructions explicitly offer "just rely on the note name changing"
 * as an equally acceptable alternative. That's the one taken here: the
 * target-note text changing *together with* the progress line's counters
 * advancing in the same render is the signal that a rotation is intentional
 * progress, not a bug -- the two update atomically from the same
 * `renderCurrentState()` call, never independently.
 *
 * **Manual skip button**: `#pp-skip-drill-btn` ("Skip this drill") wires
 * `PracticeSessionController.skipDrill()` (-> `DrillingMachine.skip()`)
 * directly -- it does NOT go through `PracticeAttemptTracker`, unlike the
 * existing `#pp-giveup-btn`, because it is a different, stronger action
 * (abandon the whole drill immediately, regardless of progress) than giving
 * up on just the current rep. The two buttons are mutually exclusive, never
 * shown together: Playing Practice's own per-attempt `#pp-giveup-btn` stays
 * exactly as it was (hidden while drilling), and `#pp-skip-drill-btn` is
 * hidden while not drilling. Deliberately not offering a *second*,
 * per-rep give-up affordance during drilling (only the one this phase's
 * scope explicitly asks for) -- the automatic per-attempt timeout
 * (`PracticeAttemptTracker`/`DEFAULT_ATTEMPT_TIMEOUT_MS`) still recovers a
 * single stuck rep on its own without a manual trigger, exactly as it
 * already did under Phase 6's placeholder, and "Skip this drill" is always
 * available as the hard stop.
 *
 * **Mastery vs. max-attempts-reached feedback**: both terminal outcomes
 * reuse the exact same `#pp-success-banner` element/timed-pause pattern as
 * Playing Practice's own "Nice!" flow (`showDrillEndBanner()`, see its doc
 * comment), just with different text/tone -- "Mastered!" (green, same as
 * "Nice!") vs. "Moving on" (a neutral blue via the `.pp-banner-neutral`
 * modifier class -- capping isn't a failure to punish, per this codebase's
 * established "learning tool, not a tuner" tone). Manual "Skip this drill"
 * clicks get no banner at all, mirroring the existing no-flourish
 * convention for Playing Practice's own manual give-up (see `applyResult`'s
 * comment on the plain `'failed'` branch) -- an intentional user action is
 * already its own signal.
 *
 * One subtlety worth flagging explicitly: `PracticeSessionController.
 * reportOutcome()` returns `void`, so this file cannot directly observe
 * *which* of Drilling's three terminal outcomes just fired. Failure can
 * only ever end a drill via the attempt cap (`DrillingMachine.reportOutcome`
 * never reaches `'mastered'` on a `'failure'` outcome), so that direction is
 * unambiguous. A *successful* rep, however, can end a drill either way --
 * mastered, or capped-on-a-success if this rep doesn't reach
 * `requiredConsecutiveCorrect` -- so `applyResult()` mirrors
 * `packages/core`'s own *documented* tie-break ("mastery is checked before
 * the attempt cap", see `practice-session-controller.ts`'s and
 * `drilling.ts`'s doc comments) using only the already-public
 * `consecutiveCorrect`/`requiredConsecutiveCorrect` fields captured just
 * before calling `reportOutcome`. This is a one-line mirror of a stable,
 * documented contract, not a re-implementation of undocumented internals --
 * but if `DrillingMachine`'s tie-break rule ever changes, this file's
 * `applyResult()` needs updating too. The cleaner long-term fix -- having
 * `reportOutcome`/`skipDrill` return the terminal `DrillingOutcome` (or
 * `undefined`) -- was deliberately not made, since it changes
 * `PracticeSessionController`'s public API surface and this phase's
 * instructions were explicit about not doing that without flagging it
 * first; flagged here accordingly rather than silently done.
 */

import {
  DEFAULT_MIN_DWELL_TIME_MS,
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
 * worklet-timestamp domain as every other timing in this pipeline -- see
 * `handleAnalysisFrame`) before advancing to the next target. A UI-timing
 * constant, not a domain/scoring concern -- deliberately kept here rather
 * than in packages/core.
 */
const SUCCESS_PAUSE_MS = 700;

export interface PlayingPracticeElements {
  readonly configDetails: HTMLDetailsElement;
  readonly stringCheckboxes: Readonly<Record<ViolinStringName, HTMLInputElement>>;
  readonly patternSelect: HTMLSelectElement;
  readonly directionSelect: HTMLSelectElement;
  readonly minFreqInput: HTMLInputElement;
  readonly maxFreqInput: HTMLInputElement;
  readonly preview: HTMLElement;
  readonly configError: HTMLElement;
  readonly startBtn: HTMLButtonElement;
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

/**
 * Owns the Playing Practice mode's whole lifecycle: reading the
 * configuration controls, generating the sequence, driving a
 * `PracticeSessionController`, and scoring each live hop through a fresh
 * `PracticeAttemptTracker` per target note. One instance for the app's
 * lifetime (mirrors `AudioCaptureController`'s own "one instance, `start`/
 * `stop`-style lifecycle" shape) -- constructed once in renderer.ts and fed
 * every analysis hop via `handleAnalysisFrame`, regardless of which mode
 * tab is currently visible (see renderer.ts's mode-switching code for why
 * this keeps running in the background rather than being torn down on tab
 * switch: switching back to this tab should not have lost its place).
 */
export class PlayingPracticeUi {
  private notes: readonly SequenceNote[] = [];
  private controller: PracticeSessionController | undefined;
  private tracker: PracticeAttemptTracker | undefined;
  /** Set while the "Nice!" banner is showing; `handleAnalysisFrame` ignores frames until this worklet-timestamp is reached, then advances. */
  private pauseUntilMs: number | undefined;

  constructor(private readonly el: PlayingPracticeElements) {
    const onConfigChange = (): void => this.updatePreview();
    for (const checkbox of Object.values(this.el.stringCheckboxes)) {
      checkbox.addEventListener('change', onConfigChange);
    }
    this.el.patternSelect.addEventListener('change', onConfigChange);
    this.el.directionSelect.addEventListener('change', onConfigChange);
    this.el.minFreqInput.addEventListener('input', onConfigChange);
    this.el.maxFreqInput.addEventListener('input', onConfigChange);
    this.el.startBtn.addEventListener('click', () => this.start());
    this.el.restartBtn.addEventListener('click', () => this.showConfigAgain());
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
      // the current rep. See this module's doc comment on why these are two
      // distinct, mutually-exclusive controls rather than one button reused.
      if (!this.controller || this.controller.state.mode !== 'drilling') return;
      this.controller.skipDrill();
      this.renderCurrentState();
    });

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

    this.notes = notes;
    this.controller = new PracticeSessionController(notes);
    this.pauseUntilMs = undefined;
    this.el.configDetails.open = false;
    this.el.session.hidden = false;
    this.el.complete.hidden = true;
    this.renderCurrentState();
  }

  private showConfigAgain(): void {
    this.controller = undefined;
    this.tracker = undefined;
    this.pauseUntilMs = undefined;
    this.notes = [];
    this.el.session.hidden = true;
    this.el.complete.hidden = true;
    this.el.configDetails.open = true;
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

    this.el.targetNote.textContent = state.targetNote.note.label;

    // Live feedback + dwell progress: real PracticeAttemptTracker-driven
    // scoring UI, reused verbatim by both Playing Practice and Drilling as
    // of Phase 7 (see this module's doc comment) -- no longer withheld for
    // isDrilling. Reset unconditionally on every new target regardless of
    // mode: the fresh PracticeAttemptTracker constructed below means a
    // clean dwell/timeout clock either way, so stale text/fill from the
    // previous target must not linger into this one.
    this.el.liveFeedback.textContent = '';
    this.el.dwellFill.style.width = '0%';

    // Manual escape hatches: exactly one visible at a time. Playing
    // Practice's own per-attempt "give up on this note" (unchanged since
    // Phase 6) vs. Drilling's whole-drill "skip this drill" (new this
    // phase) -- see this module's doc comment for why these intentionally
    // never show together.
    this.el.giveUpBtn.hidden = isDrilling;
    this.el.skipDrillBtn.hidden = !isDrilling;

    this.tracker = new PracticeAttemptTracker(state.targetNote.frequencyHz);
  }

  private applyResult(result: PracticeAttemptStatus, timestampMs: number): void {
    if (!this.controller) return;
    // Captured once, before reportOutcome() below can change it -- used
    // both to detect a drill-ending transition and (for the success case)
    // to mirror packages/core's mastery-vs-cap tie-break. See this module's
    // doc comment for the full reasoning.
    const stateBefore = this.controller.state;

    if (result.status === 'in-progress') {
      // Reused verbatim by Drilling as of Phase 7 -- no longer skipped for
      // a drilling rep, see this module's doc comment and
      // renderCurrentState()'s own comment on the dwell bar.
      const fraction = Math.min(1, result.heldMs / DEFAULT_MIN_DWELL_TIME_MS);
      this.el.dwellFill.style.width = `${fraction * 100}%`;
      return;
    }

    if (result.status === 'succeeded') {
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
          // consecutiveCorrect/requiredConsecutiveCorrect fields captured
          // in `stateBefore` -- see this module's doc comment for why this
          // is a deliberate, flagged UI-layer mirror of a stable contract,
          // not a change to packages/core's public API.
          const mastered =
            stateBefore.consecutiveCorrect + 1 >= stateBefore.requiredConsecutiveCorrect;
          this.showDrillEndBanner(mastered ? 'mastered' : 'capped', timestampMs);
          return;
        }
        // Still drilling (a 'continue' outcome) -- no success flourish for
        // a single rep; the rotated target note plus the progress line's
        // counters advancing together is the visible signal (see this
        // module's doc comment on the deliberate no-role-indicator choice).
        this.renderCurrentState();
        return;
      }

      if (this.controller.state.mode === 'complete') {
        // Go straight to the "Sequence complete!" screen rather than
        // queuing the usual "Nice!" pause below -- the complete screen is
        // itself a clear success indicator, and this avoids a real (if
        // narrow) bug the pause would otherwise have: `pauseUntilMs` is
        // only ever cleared by a *later* `handleAnalysisFrame` call (there
        // is no real setTimeout backing it -- see this class's doc
        // comment), so if capture stops right as the very last note
        // succeeds, no later frame would ever arrive to clear the pause and
        // reveal the complete screen. Calling the synchronous
        // `renderCurrentState()` directly here has no such dependency.
        // Non-final successes still get the ordinary pause below -- being
        // stuck an extra beat on the *current* (already-correct) target
        // note if capture happens to stop mid-pause is a much smaller,
        // self-recovering staleness than never reaching "complete" at all.
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
      // mastery (again see DrillingMachine.reportOutcome) -- this is
      // unambiguously 'max-attempts-reached'.
      this.showDrillEndBanner('capped', timestampMs);
      return;
    }
    // Otherwise: either a plain Playing-Practice-level failure that just
    // *started* a new drill (state.mode is now 'drilling', so the guard
    // above correctly does not treat this as a drill *ending*) or a
    // continuing drill rep -- no special flourish either way; the
    // mode-label/target-note change on the very next render is itself the
    // visible signal.
    this.renderCurrentState();
  }

  /**
   * Shows the brief "Mastered!"/"Moving on" banner when a drill ends, then
   * -- exactly like the "Nice!" pause above -- hands control back after
   * SUCCESS_PAUSE_MS. Reuses `#pp-success-banner` itself (not a second,
   * parallel banner element); the two terminal outcomes read differently
   * (green "Mastered!", same as "Nice!", vs. a neutral blue "Moving on" via
   * the `.pp-banner-neutral` modifier class) per this module's doc comment
   * on why capping isn't a failure to punish. Also mirrors the "Nice!"
   * pause's own complete-screen special case, for the identical reason:
   * `pauseUntilMs` is only ever cleared by a *later* `handleAnalysisFrame`
   * call, so if a mastered/capped drill's `resumeAtIndex` lands on
   * 'complete' and capture happens to stop right then, no later frame would
   * ever arrive to reveal the complete screen -- skip the pause and render
   * immediately instead, same as the plain success path above.
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
   * renderer.ts's `handleAnalysis` alongside (not instead of) the existing
   * Finger Tuner code, using the exact same `reading`/`rawReading`/
   * `message.workletTimestampMs` values that code already computes --
   * Finger Tuner's own logic is untouched, this is purely additive.
   * A no-op whenever no sequence has been started yet (`this.controller`
   * undefined).
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
    // `!== 'complete'`: the state is a 3-way union, and only a
    // positive-literal check narrows `state.targetNote` into scope. In
    // practice `this.tracker` is undefined whenever mode is 'complete' (see
    // renderCurrentState()), so the guard above already rules that case
    // out at runtime -- this is also satisfying the type-checker correctly,
    // not just working around it. As of Phase 7 this covers 'drilling' too
    // (previously 'playing-practice' only) -- see this module's doc comment
    // on reusing the live-feedback line for Drilling attempts.
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
