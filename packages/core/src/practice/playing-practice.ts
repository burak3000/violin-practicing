/**
 * Playing Practice: current target note -> user plays -> success (advance
 * to next note in sequence) or failure (hand off to Drilling).
 *
 * Scope note (mirrors drilling.ts's): this machine transitions on an
 * already-decided `'success' | 'failure'` outcome. Deciding *when* a
 * successful hold occurred, and *when to give up* and call an attempt a
 * failure, is `./practice-attempt-tracker.ts`'s `PracticeAttemptTracker`'s
 * job (composing `scoring.ts`'s `TargetNoteDwellTracker` with a give-up
 * policy, given a live reading stream) — resolved in Phase 6; see that
 * module's doc comment for the policy itself.
 */

import type { SequenceNote } from '../sequence/sequence-generator.js';
import { computeDrillPool, type DrillPoolNote } from './drilling.js';

export type PlayingPracticeState =
  | { readonly status: 'active'; readonly index: number; readonly targetNote: SequenceNote }
  | { readonly status: 'complete' };

export type PlayingPracticeOutcome =
  | { readonly type: 'advanced'; readonly index: number; readonly targetNote: SequenceNote }
  | { readonly type: 'sequence-complete' }
  | {
      readonly type: 'failed';
      readonly failedIndex: number;
      readonly drillPool: readonly DrillPoolNote[];
    };

/**
 * States: `active` (a current target note awaiting an attempt) <->
 * (on success) `active` at the next index, or `complete` if that was the
 * last note; (on failure) stays conceptually "paused" at `failedIndex`
 * until the caller calls `resumeAt` (typically with a `DrillingMachine`
 * outcome's `resumeAtIndex` — see drilling.ts) to continue. `complete` is
 * terminal for forward progress but `resumeAt` can still re-enter it
 * (e.g. to restart), since this class does not own "start a new session"
 * policy.
 */
export class PlayingPracticeMachine {
  private readonly notes: readonly SequenceNote[];
  private index: number;

  constructor(notes: readonly SequenceNote[], startIndex = 0) {
    if (notes.length === 0) {
      throw new RangeError('PlayingPracticeMachine: notes must not be empty');
    }
    this.notes = notes;
    this.index = startIndex;
  }

  get state(): PlayingPracticeState {
    if (this.index >= this.notes.length) {
      return { status: 'complete' };
    }
    return { status: 'active', index: this.index, targetNote: this.notes[this.index]! };
  }

  /** Report the outcome of the current attempt on `state.targetNote`. Throws if the sequence is already complete. */
  reportOutcome(outcome: 'success' | 'failure'): PlayingPracticeOutcome {
    if (this.index >= this.notes.length) {
      throw new Error(
        'PlayingPracticeMachine: reportOutcome called after the sequence is already complete',
      );
    }
    const currentIndex = this.index;

    if (outcome === 'failure') {
      return {
        type: 'failed',
        failedIndex: currentIndex,
        drillPool: computeDrillPool(this.notes, currentIndex),
      };
    }

    this.index += 1;
    if (this.index >= this.notes.length) {
      return { type: 'sequence-complete' };
    }
    return { type: 'advanced', index: this.index, targetNote: this.notes[this.index]! };
  }

  /**
   * Jump to a specific index — used to resume after a Drilling session ends
   * (mastered / capped / skipped), per that outcome's `resumeAtIndex`. An
   * index >= the sequence length resolves to `complete`, so a Drilling
   * hand-off past the last note correctly ends the session rather than
   * throwing.
   */
  resumeAt(index: number): void {
    if (index < 0) {
      throw new RangeError(`PlayingPracticeMachine.resumeAt: index must be >= 0, got ${index}`);
    }
    this.index = index;
  }
}
