/**
 * PracticeSessionController: composes PlayingPracticeMachine + DrillingMachine
 * into the single unified state machine a UI actually drives, implementing
 * the failure hand-off the plan describes ("on failure, hand off to
 * Drilling ... on mastery or skip, hand control back to Playing Practice's
 * sequence at the right point").
 *
 * This composition is itself domain logic (sequencing between two domain
 * state machines), not UI wiring, so it lives here rather than being left
 * for a platform-integration phase to invent per-platform. Each of
 * PlayingPracticeMachine and DrillingMachine remains independently usable
 * and independently tested — a caller that wants different hand-off policy
 * is free to wire them together itself instead of using this controller.
 */

import type { DrillingConfig } from './drilling.js';
import { DrillingMachine } from './drilling.js';
import { PlayingPracticeMachine } from './playing-practice.js';
import type { SequenceNote } from '../sequence/sequence-generator.js';

export type PracticeSessionState =
  | { readonly mode: 'playing-practice'; readonly index: number; readonly targetNote: SequenceNote }
  | {
      readonly mode: 'drilling';
      readonly targetNote: SequenceNote;
      readonly consecutiveCorrect: number;
      readonly attemptsUsed: number;
      readonly requiredConsecutiveCorrect: number;
      readonly maxAttempts: number;
    }
  | { readonly mode: 'complete' };

export class PracticeSessionController {
  private readonly notes: readonly SequenceNote[];
  private readonly drillingConfig: DrillingConfig;
  private playingPractice: PlayingPracticeMachine;
  private drilling: DrillingMachine | undefined;

  constructor(notes: readonly SequenceNote[], drillingConfig: DrillingConfig = {}) {
    this.notes = notes;
    this.drillingConfig = drillingConfig;
    this.playingPractice = new PlayingPracticeMachine(notes);
  }

  get state(): PracticeSessionState {
    if (this.drilling !== undefined && !this.drilling.isFinished) {
      const current = this.drilling.currentNote;
      return {
        mode: 'drilling',
        targetNote: current.note,
        consecutiveCorrect: this.drilling.consecutiveCorrectCount,
        attemptsUsed: this.drilling.attemptsUsedCount,
        requiredConsecutiveCorrect: this.drillingConfig.requiredConsecutiveCorrect ?? 3,
        maxAttempts: this.drillingConfig.maxAttempts ?? 12,
      };
    }
    const ppState = this.playingPractice.state;
    if (ppState.status === 'complete') {
      return { mode: 'complete' };
    }
    return { mode: 'playing-practice', index: ppState.index, targetNote: ppState.targetNote };
  }

  /**
   * Report the outcome of the current attempt on `state.targetNote`,
   * whichever mode is currently active. Throws if the session is already
   * complete.
   */
  reportOutcome(outcome: 'success' | 'failure'): void {
    if (this.drilling !== undefined && !this.drilling.isFinished) {
      const result = this.drilling.reportOutcome(outcome);
      if (result.type !== 'continue') {
        this.playingPractice.resumeAt(result.resumeAtIndex);
        this.drilling = undefined;
      }
      return;
    }

    const ppState = this.playingPractice.state;
    if (ppState.status === 'complete') {
      throw new Error(
        'PracticeSessionController: reportOutcome called after the session is already complete',
      );
    }
    const result = this.playingPractice.reportOutcome(outcome);
    if (result.type === 'failed') {
      this.drilling = new DrillingMachine(result.drillPool, this.drillingConfig);
    }
  }

  /** Manual skip escape hatch. Throws if not currently drilling (a caller should only offer/enable this control while `state.mode === 'drilling'`). */
  skipDrill(): void {
    if (this.drilling === undefined || this.drilling.isFinished) {
      throw new Error('PracticeSessionController: skipDrill called while not drilling');
    }
    const result = this.drilling.skip();
    this.playingPractice.resumeAt(result.resumeAtIndex);
    this.drilling = undefined;
  }
}
