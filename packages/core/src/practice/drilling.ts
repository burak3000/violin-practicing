/**
 * Drilling: the failure-recovery submode triggered when Playing Practice
 * fails a note.
 *
 * Per the plan: repeats the failed note plus its immediate scale-neighbors
 * (one step above/below from the same procedural pool) until N consecutive
 * correct passes; must have a configurable max-attempt cap AND a manual
 * skip escape hatch (an unbounded drill loop is an explicitly-called-out
 * real UX edge case, not hypothetical).
 *
 * Scope note: this module decides *what to drill next* and *when drilling
 * ends* (mastered / capped / skipped). It does not decide, in real time,
 * whether a given attempt was a success or failure — that judgment comes
 * from feeding a target reading stream through
 * `scoring.ts`'s `TargetNoteDwellTracker` against whichever drill note is
 * currently active, and the caller reports the outcome via `reportOutcome`.
 * Determining *when to give up and call an attempt a failure* in real time
 * (a timeout, N bad tries, a UI affordance) was originally left as a
 * session/UI-orchestration policy for a later platform-integration phase to
 * decide — **resolved in Phase 6** by `./practice-attempt-tracker.ts`'s
 * `PracticeAttemptTracker`, which composes `TargetNoteDwellTracker` with a
 * give-up policy (a manual escape hatch plus a default elapsed-time
 * timeout, both tunable) to answer exactly this question from a live
 * reading stream. See that module's own doc comment for the full policy
 * and reasoning.
 */

import type { SequenceNote } from '../sequence/sequence-generator.js';

export type DrillPoolRole = 'neighbor-below' | 'center' | 'neighbor-above';

export interface DrillPoolNote {
  /** Index into the original Playing Practice sequence this drill note came from. */
  readonly sequenceIndex: number;
  readonly note: SequenceNote;
  readonly role: DrillPoolRole;
}

/**
 * Builds the drill pool for a failed note: the failed note itself plus its
 * immediate neighbors *in the generated sequence array* (one step back and
 * one step forward), clamped at the sequence's boundaries. "Neighbor in the
 * sequence array" is what "immediate scale-neighbor from the same
 * procedural pool" means here, since the sequence itself already lays out
 * that pool in scale order — for the common single-string,
 * ascending/descending-only case this is exactly the musical neighbor
 * above/below. The one documented edge case: at a boundary between two
 * different strings in a multi-string sequence, the array-adjacent note can
 * be the *other* string's first/last note rather than a musical scale
 * neighbor of the failed note. This is a deliberately simple, reversible
 * choice (see this package's CLAUDE.md) rather than re-deriving music-theory
 * adjacency independently of the sequence that was already built.
 */
export function computeDrillPool(
  notes: readonly SequenceNote[],
  centerIndex: number,
): DrillPoolNote[] {
  if (centerIndex < 0 || centerIndex >= notes.length) {
    throw new RangeError(
      `computeDrillPool: centerIndex ${centerIndex} out of bounds for ${notes.length} notes`,
    );
  }
  const pool: DrillPoolNote[] = [];
  if (centerIndex > 0) {
    pool.push({
      sequenceIndex: centerIndex - 1,
      note: notes[centerIndex - 1]!,
      role: 'neighbor-below',
    });
  }
  pool.push({ sequenceIndex: centerIndex, note: notes[centerIndex]!, role: 'center' });
  if (centerIndex < notes.length - 1) {
    pool.push({
      sequenceIndex: centerIndex + 1,
      note: notes[centerIndex + 1]!,
      role: 'neighbor-above',
    });
  }
  return pool;
}

export interface DrillingConfig {
  /** Consecutive correct passes (across the whole pool, not per-note) required to master the drill. Default 3. */
  readonly requiredConsecutiveCorrect?: number;
  /**
   * Hard cap on total attempts before drilling force-ends as
   * 'max-attempts-reached', regardless of progress. Default 12 — generous
   * enough for genuine focused practice on a hard note (e.g. 4 full passes
   * through a 3-note pool) while still bounded, per the plan's explicit
   * "unbounded drilling is a real UX edge case" instruction. Tunable, not
   * locked.
   */
  readonly maxAttempts?: number;
}

export const DEFAULT_REQUIRED_CONSECUTIVE_CORRECT = 3;
export const DEFAULT_MAX_DRILL_ATTEMPTS = 12;

/** Why drilling ended, plus where Playing Practice should resume. */
export type DrillingOutcome =
  | {
      readonly type: 'continue';
      readonly nextNote: DrillPoolNote;
      readonly consecutiveCorrect: number;
      readonly attemptsUsed: number;
    }
  | { readonly type: 'mastered'; readonly resumeAtIndex: number }
  | { readonly type: 'max-attempts-reached'; readonly resumeAtIndex: number }
  | { readonly type: 'skipped'; readonly resumeAtIndex: number };

/**
 * Drilling state machine. States: `active` (drilling in progress, tracking
 * consecutiveCorrect/attemptsUsed) -> one of three terminal states
 * (`mastered` / `max-attempts-reached` / `skipped`), each reached via
 * `reportOutcome` or `skip`. Once terminal, further calls throw (construct a
 * new instance for a new drill).
 *
 * Resume-point policy (a documented judgment call, not specified by the
 * plan at this level of detail — see this package's CLAUDE.md and the
 * Phase 2 report): **all three terminal outcomes resume Playing Practice at
 * `centerIndex + 1`** (the note *after* the one that failed), not back at
 * the failed note itself. Reasoning: the drill pool's rotation already
 * includes repeated correct reps of the center note by the time mastery is
 * reached, so re-testing the identical note again immediately in Playing
 * Practice adds little and risks recreating the exact stuck-loop scenario
 * the plan warns about (fail -> drill -> land back on the same note ->
 * fail again -> drill again -> ...); capped/skipped drills resume the same
 * way so the user is never blocked from moving forward. This is a small,
 * easily-reversed policy (changing it doesn't change this class's public
 * shape) — flagged explicitly since the plan doesn't pin down "the right
 * point" precisely.
 */
export class DrillingMachine {
  private readonly pool: readonly DrillPoolNote[];
  private readonly centerIndex: number;
  private readonly requiredConsecutiveCorrect: number;
  private readonly maxAttempts: number;

  private cursor = 0;
  private consecutiveCorrect = 0;
  private attemptsUsed = 0;
  private outcome: DrillingOutcome | undefined;

  constructor(pool: readonly DrillPoolNote[], config: DrillingConfig = {}) {
    if (pool.length === 0) {
      throw new RangeError('DrillingMachine: pool must not be empty');
    }
    const centerCursor = pool.findIndex((p) => p.role === 'center');
    if (centerCursor === -1) {
      throw new RangeError('DrillingMachine: pool must contain exactly one "center" entry');
    }
    this.pool = pool;
    this.centerIndex = pool[centerCursor]!.sequenceIndex;
    // Drilling opens on the note the user actually just failed, not on
    // whichever pool entry happens to sit at array index 0 (a prior version
    // of this class started at a fixed `cursor = 0`, which meant drilling
    // opened on the neighbor *below* the failed note whenever one existed —
    // an unexamined default, not a deliberate "approach from below"
    // pedagogy; there's no such convention documented anywhere for this
    // app). Immediate retry of the just-missed note is the sensible default;
    // the round-robin still visits both neighbors afterward.
    this.cursor = centerCursor;
    this.requiredConsecutiveCorrect =
      config.requiredConsecutiveCorrect ?? DEFAULT_REQUIRED_CONSECUTIVE_CORRECT;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_DRILL_ATTEMPTS;
    if (this.requiredConsecutiveCorrect < 1) {
      throw new RangeError('DrillingMachine: requiredConsecutiveCorrect must be >= 1');
    }
    if (this.maxAttempts < 1) {
      throw new RangeError('DrillingMachine: maxAttempts must be >= 1');
    }
  }

  /** The drill-pool entry currently being practiced. */
  get currentNote(): DrillPoolNote {
    return this.pool[this.cursor % this.pool.length]!;
  }

  get attemptsUsedCount(): number {
    return this.attemptsUsed;
  }

  get consecutiveCorrectCount(): number {
    return this.consecutiveCorrect;
  }

  get isFinished(): boolean {
    return this.outcome !== undefined;
  }

  private resumeAtIndex(): number {
    return this.centerIndex + 1;
  }

  private assertActive(): void {
    if (this.outcome !== undefined) {
      throw new Error(
        `DrillingMachine: already finished with outcome '${this.outcome.type}' — construct a new instance to drill again`,
      );
    }
  }

  /** Report the outcome of the current attempt (on `currentNote`) and advance. */
  reportOutcome(outcome: 'success' | 'failure'): DrillingOutcome {
    this.assertActive();
    this.attemptsUsed += 1;

    if (outcome === 'success') {
      this.consecutiveCorrect += 1;
      if (this.consecutiveCorrect >= this.requiredConsecutiveCorrect) {
        this.outcome = { type: 'mastered', resumeAtIndex: this.resumeAtIndex() };
        return this.outcome;
      }
    } else {
      this.consecutiveCorrect = 0;
    }

    if (this.attemptsUsed >= this.maxAttempts) {
      this.outcome = { type: 'max-attempts-reached', resumeAtIndex: this.resumeAtIndex() };
      return this.outcome;
    }

    this.cursor += 1;
    return {
      type: 'continue',
      nextNote: this.currentNote,
      consecutiveCorrect: this.consecutiveCorrect,
      attemptsUsed: this.attemptsUsed,
    };
  }

  /** Manual escape hatch: immediately ends drilling regardless of progress. */
  skip(): Extract<DrillingOutcome, { type: 'skipped' }> {
    this.assertActive();
    const result: Extract<DrillingOutcome, { type: 'skipped' }> = {
      type: 'skipped',
      resumeAtIndex: this.resumeAtIndex(),
    };
    this.outcome = result;
    return result;
  }
}
