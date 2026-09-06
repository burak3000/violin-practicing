/**
 * PracticeAttemptTracker: the per-frame answer to "given this live reading,
 * are we still trying, did we succeed, or should we call this a failure
 * now?" -- the exact question a Playing Practice / Drilling UI needs
 * answered every hop, for one attempt at one target note.
 *
 * This fills a gap `drilling.ts` and `playing-practice.ts` both deliberately
 * leave open (see each file's own "Scope note"): `TargetNoteDwellTracker`
 * (scoring.ts) already answers "has the target been held in tune long
 * enough to count as a *success*" from a live reading stream, but nothing
 * in this package decides when to give up and call an attempt a *failure*.
 * That's a session/UI-orchestration policy the plan explicitly left to
 * "the platform-integration phases that wire this up" -- this is that
 * phase, and per Hard Rule 3 the policy is decided and documented here
 * (not silently assumed, not left for a UI to reinvent per platform) rather
 * than guessed independently by each of desktop/mobile.
 *
 * ## The give-up policy (the actual decision Hard Rule 3 requires)
 *
 * Two mechanisms, both enabled by default, either one alone sufficient to
 * end an attempt as a failure:
 *
 * 1. **A manual escape hatch** (`giveUp()`) -- a UI affordance (e.g. a
 *    "Having trouble? Skip" button), analogous to `DrillingMachine.skip()`
 *    one level up. The user should never be *required* to wait out a timer
 *    to move on.
 * 2. **An inactivity/elapsed timeout** (`timeoutMs`, default
 *    `DEFAULT_ATTEMPT_TIMEOUT_MS`) -- measured from this tracker's first
 *    `update()` call (i.e. from whenever the caller starts feeding it
 *    frames, which in practice is the moment the target note is presented
 *    -- see "Why elapsed time is measured from the first `update()` call"
 *    below), so a session doesn't hang forever if the user simply never
 *    plays anything and never touches the manual skip either. This mirrors
 *    the plan's own reasoning for Drilling's `maxAttempts` cap ("an
 *    unbounded drill loop with no exit is a real usability edge case, not
 *    just a hypothetical") one level up in the flow, before Drilling is
 *    even reached.
 *
 * Both are plain tunables on `PracticeAttemptTrackerConfig`, not locked
 * constants -- pass `timeoutMs: Number.POSITIVE_INFINITY` to disable the
 * automatic timeout entirely and rely on the manual skip alone, if a future
 * UI decides that's the better product call.
 *
 * **Why 10 seconds by default:** this package's own established tone (see
 * `DEFAULT_IN_TUNE_CENTS_TOLERANCE`'s doc comment: "this is a learning tool
 * for beginners, not a tuner") argues for generous, non-punitive defaults.
 * 10s is long enough for a beginner to locate the right string/finger and
 * settle the bow before being auto-failed into Drilling for a slow-but
 * genuine attempt, while still bounded so a truly stuck or idle session
 * recovers on its own. Auto-failing is low-stakes here, not a harsh
 * penalty: Drilling exists specifically to give repeated, structured
 * retries on exactly this note (plus its neighbors), and the user can
 * always play through it again -- so erring toward "times out a little too
 * eagerly" is a far safer default than "never times out."
 *
 * **Why the timeout clock keeps running through no-signal/unclear frames**
 * (rather than pausing while there's nothing to score): the alternative --
 * pausing elapsed time whenever the signal drops out -- risks a session
 * that never times out at all if the user simply walks away mid-attempt
 * with the mic still capturing silence. An occasional premature timeout
 * during a real but slow attempt is fully recoverable (the note reappears
 * immediately as Drilling's center note); a session stuck forever waiting
 * for a signal that never returns is not. Note this is independent of
 * dwell-time scoring itself: a no-signal/unclear frame still correctly
 * resets the *dwell* clock to zero (delegated to `TargetNoteDwellTracker`,
 * unchanged), it just doesn't reset or pause the *attempt* clock.
 *
 * **Why elapsed time is measured from the first `update()` call**, not a
 * separately-signaled "attempt started" event: `TargetNoteDwellTracker`'s
 * own documented convention is "one instance per attempt at a target
 * note", constructed exactly when that attempt begins. This class extends
 * that same convention -- a caller is expected to construct a fresh
 * `PracticeAttemptTracker` at the moment the target note is presented and
 * begin feeding it every subsequent analysis hop immediately, so "first
 * `update()` call" and "target note presented" differ by at most one hop
 * (~11.6ms at the validated 512-sample/44.1kHz hop) in practice. This is a
 * deliberate simplicity choice -- a separate explicit "start" method would
 * add API surface for a distinction that doesn't matter at this timescale.
 *
 * ## What this class does NOT do
 *
 * It does not decide *what* to do after success/failure (advance the
 * sequence, enter Drilling, etc.) -- that's `PlayingPracticeMachine` /
 * `PracticeSessionController`'s job, via their existing
 * `reportOutcome('success' | 'failure')`. This class only produces the
 * `'success'`/`'failure'` decision from a live reading stream; a caller
 * feeds that decision into whichever of those two it's using. Composing
 * "decide" (here) and "act on the decision" (those machines) instead of
 * merging them keeps each piece independently testable, matching this
 * package's existing layering (`scoring.ts` decides; `practice/*.ts` acts).
 *
 * Pure TypeScript, zero DOM/Node/React-Native imports -- shared verbatim by
 * `apps/desktop` (this phase) and `apps/mobile` (a later phase), per this
 * package's "no audio/DSP or UI code, ever" rule.
 */

import {
  TargetNoteDwellTracker,
  type DwellTrackerConfig,
  type PitchReading,
} from '../scoring/scoring.js';

/**
 * Maximum wall-clock time (ms), measured from this tracker's first
 * `update()` call, before an attempt that hasn't yet succeeded is
 * automatically ended as `{ status: 'failed', reason: 'timeout' }`. See the
 * module doc comment's "The give-up policy" section for the full reasoning
 * behind both the mechanism and this specific number. Tunable via
 * `PracticeAttemptTrackerConfig.timeoutMs`; pass
 * `Number.POSITIVE_INFINITY` to disable the automatic timeout and rely on
 * `giveUp()` alone.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;

export interface PracticeAttemptTrackerConfig extends DwellTrackerConfig {
  /** See `DEFAULT_ATTEMPT_TIMEOUT_MS`. Must be > 0 (use `Number.POSITIVE_INFINITY` to disable, not a huge finite number). */
  readonly timeoutMs?: number;
}

export type PracticeAttemptStatus =
  | {
      readonly status: 'in-progress';
      /** Milliseconds the target has been continuously held in tune so far -- see `TargetNoteDwellTracker.currentHeldMs`. 0 whenever not currently holding (including every no-signal/unclear frame). */
      readonly heldMs: number;
      /** Wall-clock milliseconds since this tracker's first `update()` call, regardless of signal quality -- what `timeoutMs` is measured against. */
      readonly elapsedMs: number;
    }
  | { readonly status: 'succeeded' }
  | {
      readonly status: 'failed';
      /** 'timeout' => the elapsed-time cap was reached without success. 'manual' => `giveUp()` was called. */
      readonly reason: 'timeout' | 'manual';
    };

/**
 * Stateful, one instance per attempt at one target note -- mirrors
 * `TargetNoteDwellTracker`'s own "one instance per attempt" convention
 * (indeed, it owns exactly one such tracker internally). Feed it every
 * live reading in timestamp order via `update()`; call `giveUp()` from a
 * manual "skip" UI affordance at any time; call `reset()` to reuse the
 * instance for a fresh attempt (e.g. retrying the same note), or simply
 * construct a new one for the next target note -- either is fine, `reset()`
 * exists purely to avoid an allocation per attempt for a caller that cares.
 *
 * Once decided (`'succeeded'` or `'failed'`), the result is a **sticky
 * latch**, matching `TargetNoteDwellTracker.isSatisfied`'s own convention:
 * every subsequent `update()` or `giveUp()` call returns the identical
 * decided result without any further state change. In particular, success
 * always wins over a race with `giveUp()` -- a `giveUp()` call that arrives
 * after success was already decided is a no-op, not a retroactive failure.
 */
export class PracticeAttemptTracker {
  private readonly dwellTracker: TargetNoteDwellTracker;
  private readonly timeoutMs: number;
  private startTimestampMs: number | undefined;
  private decided: Extract<PracticeAttemptStatus, { status: 'succeeded' | 'failed' }> | undefined;

  constructor(targetFrequencyHz: number, config: PracticeAttemptTrackerConfig = {}) {
    // Propagates TargetNoteDwellTracker's own `targetFrequencyHz > 0`
    // validation (RangeError) -- not re-checked here, one source of truth.
    this.dwellTracker = new TargetNoteDwellTracker(targetFrequencyHz, config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    if (!(this.timeoutMs > 0)) {
      throw new RangeError(`PracticeAttemptTracker: timeoutMs must be > 0, got ${this.timeoutMs}`);
    }
  }

  /**
   * Feed one timestamped reading (`timestampMs` must be non-decreasing
   * across calls on one instance -- enforced by the underlying
   * `TargetNoteDwellTracker`, whose `RangeError` propagates unchanged).
   * Success is checked before the timeout on the same frame (a reading
   * that satisfies dwell exactly as the timeout elapses resolves as a
   * success, not a race) -- mirrors `DrillingMachine.reportOutcome`'s own
   * "mastered is checked before the attempt cap" precedent.
   */
  update(reading: PitchReading, timestampMs: number): PracticeAttemptStatus {
    if (this.decided) {
      return this.decided;
    }

    if (this.startTimestampMs === undefined) {
      this.startTimestampMs = timestampMs;
    }

    if (this.dwellTracker.update(reading, timestampMs)) {
      this.decided = { status: 'succeeded' };
      return this.decided;
    }

    const elapsedMs = timestampMs - this.startTimestampMs;
    if (elapsedMs >= this.timeoutMs) {
      this.decided = { status: 'failed', reason: 'timeout' };
      return this.decided;
    }

    return { status: 'in-progress', heldMs: this.dwellTracker.currentHeldMs, elapsedMs };
  }

  /**
   * Manual escape hatch for a "Having trouble? Skip" style UI affordance.
   * A no-op returning the existing decided result if the attempt is
   * already decided (including an already-`'succeeded'` attempt -- success
   * is never retroactively turned into a failure).
   */
  giveUp(): PracticeAttemptStatus {
    this.decided ??= { status: 'failed', reason: 'manual' };
    return this.decided;
  }

  get isDecided(): boolean {
    return this.decided !== undefined;
  }

  /** Resets to a fresh attempt at the *same* target note (construct a new instance instead if the target note itself changes). */
  reset(): void {
    this.dwellTracker.reset();
    this.startTimestampMs = undefined;
    this.decided = undefined;
  }
}
