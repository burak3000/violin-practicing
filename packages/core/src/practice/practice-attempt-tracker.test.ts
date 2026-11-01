import { describe, expect, it } from 'vitest';
import { generatePlayingPracticeSequence } from '../sequence/sequence-generator.js';
import type { PitchReading } from '../scoring/scoring.js';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, PracticeAttemptTracker } from './practice-attempt-tracker.js';
import { PracticeSessionController } from './practice-session-controller.js';

const voiced = (frequencyHz: number, confidence = 0.9): PitchReading => ({
  voiced: true,
  frequencyHz,
  confidence,
});
const unvoiced: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

describe('PracticeAttemptTracker: construction', () => {
  it("propagates TargetNoteDwellTracker's targetFrequencyHz > 0 validation", () => {
    expect(() => new PracticeAttemptTracker(0)).toThrow(RangeError);
    expect(() => new PracticeAttemptTracker(-1)).toThrow(RangeError);
  });

  it('throws on a non-positive timeoutMs', () => {
    expect(() => new PracticeAttemptTracker(440, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => new PracticeAttemptTracker(440, { timeoutMs: -100 })).toThrow(RangeError);
  });

  it('accepts Number.POSITIVE_INFINITY as an explicit "disable the timeout" value', () => {
    expect(
      () => new PracticeAttemptTracker(440, { timeoutMs: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });

  it('documents the chosen default timeout', () => {
    expect(DEFAULT_ATTEMPT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('PracticeAttemptTracker: clean success path', () => {
  it('reports in-progress while dwell has not yet been satisfied, then succeeded exactly once the dwell threshold is crossed', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150 });

    const first = tracker.update(voiced(440), 0);
    expect(first).toEqual({ status: 'in-progress', heldMs: 0, elapsedMs: 0 });

    const mid = tracker.update(voiced(440), 100);
    expect(mid).toEqual({ status: 'in-progress', heldMs: 100, elapsedMs: 100 });

    const done = tracker.update(voiced(440), 150);
    expect(done).toEqual({ status: 'succeeded' });
    expect(tracker.isDecided).toBe(true);
  });

  it('is sticky: further update() calls after success keep returning succeeded, even with a garbage reading', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toEqual({ status: 'succeeded' });
    expect(tracker.update(unvoiced, 200)).toEqual({ status: 'succeeded' });
    expect(tracker.update(voiced(900), 300)).toEqual({ status: 'succeeded' });
  });

  it('a late giveUp() after success is a no-op -- success is never retroactively turned into a failure', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toEqual({ status: 'succeeded' });
    expect(tracker.giveUp()).toEqual({ status: 'succeeded' });
  });

  it('success is checked before timeout on the same frame (mirrors DrillingMachine: mastery beats the cap)', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100, timeoutMs: 100 });
    tracker.update(voiced(440), 0);
    // At t=100, both the dwell threshold (100ms held) and the timeout
    // (100ms elapsed) are crossed simultaneously -- success must win.
    expect(tracker.update(voiced(440), 100)).toEqual({ status: 'succeeded' });
  });
});

describe('PracticeAttemptTracker: give-up path -- manual', () => {
  it('giveUp() ends the attempt immediately as a manual failure', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150 });
    tracker.update(voiced(440), 0);
    const result = tracker.giveUp();
    expect(result).toEqual({ status: 'failed', reason: 'manual' });
    expect(tracker.isDecided).toBe(true);
  });

  it('giveUp() works even before any update() call', () => {
    const tracker = new PracticeAttemptTracker(440);
    expect(tracker.giveUp()).toEqual({ status: 'failed', reason: 'manual' });
  });

  it('is sticky and idempotent: repeated giveUp() calls return the same result', () => {
    const tracker = new PracticeAttemptTracker(440);
    const first = tracker.giveUp();
    const second = tracker.giveUp();
    expect(first).toEqual(second);
  });

  it('further update() calls after a manual give-up keep returning the failed result, not a fresh attempt', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    tracker.giveUp();
    expect(tracker.update(voiced(440), 50)).toEqual({ status: 'failed', reason: 'manual' });
    expect(tracker.update(voiced(440), 200)).toEqual({ status: 'failed', reason: 'manual' });
  });
});

describe('PracticeAttemptTracker: give-up path -- timeout', () => {
  it('auto-fails once elapsed time (since the first update() call) reaches timeoutMs, even while still voiced but out of tune', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150, timeoutMs: 300 });
    // Way off target the entire time -- never satisfies dwell.
    expect(tracker.update(voiced(500), 0)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 0,
    });
    expect(tracker.update(voiced(500), 150)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 150,
    });
    expect(tracker.update(voiced(500), 299)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 299,
    });
    expect(tracker.update(voiced(500), 300)).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('the timeout clock keeps running through silence (no-signal) -- a user who never plays still eventually times out', () => {
    const tracker = new PracticeAttemptTracker(440, { timeoutMs: 300 });
    tracker.update(unvoiced, 0);
    tracker.update(unvoiced, 150);
    expect(tracker.update(unvoiced, 300)).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('elapsed time is measured from the first update() call, not from a fixed absolute clock', () => {
    const tracker = new PracticeAttemptTracker(440, { timeoutMs: 300 });
    // Attempt "starts" at t=1000 (e.g. the target note was presented well
    // into a longer session), not at t=0.
    expect(tracker.update(unvoiced, 1000)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 0,
    });
    expect(tracker.update(unvoiced, 1250)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 250,
    });
    expect(tracker.update(unvoiced, 1300)).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('a disabled timeout (Number.POSITIVE_INFINITY) never auto-fails, however long the attempt runs', () => {
    const tracker = new PracticeAttemptTracker(440, { timeoutMs: Number.POSITIVE_INFINITY });
    for (let t = 0; t <= 100_000; t += 20_000) {
      expect(tracker.update(voiced(500), t).status).toBe('in-progress');
    }
  });
});

describe('PracticeAttemptTracker: no-signal/unclear passthrough (does not falsely advance the dwell timer)', () => {
  it('an unvoiced reading reports in-progress with heldMs 0, never succeeded', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150 });
    const result = tracker.update(unvoiced, 0);
    expect(result).toEqual({ status: 'in-progress', heldMs: 0, elapsedMs: 0 });
  });

  it('a low-confidence ("unclear") reading also reports in-progress with heldMs 0', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150 });
    const result = tracker.update(voiced(440, 0.1), 0);
    expect(result).toEqual({ status: 'in-progress', heldMs: 0, elapsedMs: 0 });
  });

  it('a stretch of no-signal frames in the middle of an otherwise-good attempt resets held progress but not the attempt clock, and success is still reachable afterward', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150, timeoutMs: 5000 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toEqual({
      status: 'in-progress',
      heldMs: 100,
      elapsedMs: 100,
    });
    // Bow lifts / brief dropout at t=120: dwell resets to 0, but the
    // overall attempt clock (elapsedMs) keeps counting from t=0.
    expect(tracker.update(unvoiced, 120)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 120,
    });
    // Bow comes back down in tune at t=140: dwell restarts from here.
    expect(tracker.update(voiced(440), 140)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 140,
    });
    expect(tracker.update(voiced(440), 290)).toEqual({ status: 'succeeded' });
  });

  it('an out-of-tolerance (but voiced and confident) reading also resets held progress without ending the attempt', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 150, timeoutMs: 5000 });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440), 100);
    // A whole semitone sharp -- gated ok, but outside the in-tune tolerance.
    const semitoneUp = 440 * 2 ** (1 / 12);
    expect(tracker.update(voiced(semitoneUp), 120)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 120,
    });
  });
});

describe('PracticeAttemptTracker: reset', () => {
  it('reset() clears decided/held/elapsed state so the instance can be reused for a fresh attempt at the same note', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toEqual({ status: 'succeeded' });

    tracker.reset();
    expect(tracker.isDecided).toBe(false);
    expect(tracker.update(voiced(440), 10_000)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 0,
    });
    expect(tracker.update(voiced(440), 10_100)).toEqual({ status: 'succeeded' });
  });

  it('reset() also clears a manual give-up', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.giveUp();
    tracker.reset();
    expect(tracker.isDecided).toBe(false);
  });
});

describe('PracticeAttemptTracker: requireReleaseFirst (repeated same-pitch targets)', () => {
  it('does not count a note that was already sounding when the target appeared', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
    });
    // The player is still holding the previous (same-pitch) note.
    expect(tracker.update(voiced(440), 0)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 0,
    });
    expect(tracker.update(voiced(440), 100)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 100,
    });
    expect(tracker.update(voiced(440), 500)).toMatchObject({ status: 'in-progress', heldMs: 0 });
  });

  it('starts counting after a gap, and succeeds once the dwell time is held afterwards', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
    });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440), 50);
    tracker.update(unvoiced, 100); // bow change / gap: released
    expect(tracker.update(voiced(440), 150)).toMatchObject({ status: 'in-progress', heldMs: 0 });
    expect(tracker.update(voiced(440), 200)).toMatchObject({ status: 'in-progress', heldMs: 50 });
    expect(tracker.update(voiced(440), 250)).toEqual({ status: 'succeeded' });
  });

  it('counts moving to a different pitch as leaving the target', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
    });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(660), 50); // a clearly different pitch
    tracker.update(voiced(440), 100);
    expect(tracker.update(voiced(440), 200)).toEqual({ status: 'succeeded' });
  });

  it('counts a low-confidence frame as a release', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
    });
    tracker.update(voiced(440), 0);
    tracker.update(voiced(440, 0.1), 50);
    tracker.update(voiced(440), 100);
    expect(tracker.update(voiced(440), 200)).toEqual({ status: 'succeeded' });
  });

  it('still times out if the player never lets go of the previous note', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      timeoutMs: 1000,
      requireReleaseFirst: true,
    });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 1000)).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('can still be given up on manually while waiting for the release', () => {
    const tracker = new PracticeAttemptTracker(440, { requireReleaseFirst: true });
    tracker.update(voiced(440), 0);
    expect(tracker.giveUp()).toEqual({ status: 'failed', reason: 'manual' });
  });

  it('is off by default: a note already sounding counts immediately', () => {
    const tracker = new PracticeAttemptTracker(440, { minDwellTimeMs: 100 });
    tracker.update(voiced(440), 0);
    expect(tracker.update(voiced(440), 100)).toEqual({ status: 'succeeded' });
  });

  it('reset() re-arms the release requirement', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
    });
    tracker.update(unvoiced, 0);
    tracker.update(voiced(440), 50);
    expect(tracker.update(voiced(440), 150)).toEqual({ status: 'succeeded' });

    tracker.reset();
    tracker.update(voiced(440), 1000);
    expect(tracker.update(voiced(440), 1200)).toMatchObject({ status: 'in-progress', heldMs: 0 });
  });

  it('honours a custom tolerance when deciding whether a frame still counts as the held target', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      requireReleaseFirst: true,
      inTuneCentsTolerance: 10,
    });
    tracker.update(voiced(440), 0);
    // 20 cents sharp: outside the 10c tolerance, so this is a release even though it is the "same note".
    tracker.update(voiced(440 * 2 ** (20 / 1200)), 50);
    tracker.update(voiced(440), 100);
    expect(tracker.update(voiced(440), 200)).toEqual({ status: 'succeeded' });
  });
});

describe('PracticeAttemptTracker: config passthrough to the underlying dwell tracker', () => {
  it('honors a custom inTuneCentsTolerance', () => {
    const tracker = new PracticeAttemptTracker(440, {
      minDwellTimeMs: 100,
      inTuneCentsTolerance: 5,
      timeoutMs: 5000,
    });
    // ~19.6 cents sharp -- within the package default (25c) but outside this tightened 5c one.
    tracker.update(voiced(445), 0);
    expect(tracker.update(voiced(445), 100)).toEqual({
      status: 'in-progress',
      heldMs: 0,
      elapsedMs: 100,
    });
  });

  it('honors a custom minConfidence', () => {
    const tracker = new PracticeAttemptTracker(440, { minConfidence: 0.95, timeoutMs: 5000 });
    // Passes the package default (0.5) but not this stricter 0.95 floor.
    const result = tracker.update(voiced(440, 0.8), 0);
    expect(result).toEqual({ status: 'in-progress', heldMs: 0, elapsedMs: 0 });
  });
});

/**
 * These tests exercise exactly the pattern a UI (apps/desktop's Playing
 * Practice mode, this phase) actually drives: `generatePlayingPracticeSequence`
 * produces the note pool, `PracticeSessionController` owns the
 * Playing-Practice<->Drilling hand-off, and a fresh `PracticeAttemptTracker`
 * per target note decides success/failure from a synthetic live-reading
 * feed. No DOM/Electron involved -- this is the platform-agnostic core of
 * what the desktop (and later mobile) UI wires up, so it belongs here
 * rather than as an untestable manual-only claim.
 */
describe('PracticeAttemptTracker: integration with PracticeSessionController + generatePlayingPracticeSequence', () => {
  it('walks a full generated sequence start to finish using a synthetic in-tune reading feed', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'stepwise-first-position',
    });
    expect(notes.length).toBe(5); // G3 A3 B3 C4 D4 -- FIRST_POSITION_SEMITONE_OFFSETS

    const controller = new PracticeSessionController(notes);
    let iterations = 0;

    while (controller.state.mode !== 'complete') {
      iterations += 1;
      if (iterations > notes.length) {
        throw new Error('test bug: exceeded expected iteration count without completing');
      }
      const state = controller.state;
      if (state.mode !== 'playing-practice') {
        throw new Error(`unexpected state.mode ${state.mode} -- this test never fails an attempt`);
      }
      const targetFrequencyHz = state.targetNote.frequencyHz;
      const tracker = new PracticeAttemptTracker(targetFrequencyHz, { minDwellTimeMs: 50 });

      let result = tracker.update(voiced(targetFrequencyHz), 0);
      let t = 0;
      while (result.status === 'in-progress') {
        t += 20;
        result = tracker.update(voiced(targetFrequencyHz), t);
      }
      expect(result).toEqual({ status: 'succeeded' });
      controller.reportOutcome('success');
    }

    expect(iterations).toBe(5);
    expect(controller.state).toEqual({ mode: 'complete' });
  });

  it('a failed first attempt hands off to Drilling, which can be walked to mastery and correctly resumes Playing Practice', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
    });
    const controller = new PracticeSessionController(notes, { requiredConsecutiveCorrect: 2 });

    expect(controller.state).toEqual({ mode: 'playing-practice', index: 0, targetNote: notes[0] });

    // Give up on the very first note (a manual "having trouble? skip" --
    // see PracticeAttemptTracker's give-up policy) rather than waiting out
    // a timeout, to keep this test fast and deterministic.
    const firstAttempt = new PracticeAttemptTracker(notes[0]!.frequencyHz);
    expect(firstAttempt.giveUp()).toEqual({ status: 'failed', reason: 'manual' });
    controller.reportOutcome('failure');

    // Boundary note (index 0): drill pool is [center, neighbor-above], no
    // neighbor-below -- see drilling.ts's computeDrillPool. Drilling opens
    // on the failed note itself.
    let state = controller.state;
    expect(state).toMatchObject({ mode: 'drilling', targetNote: notes[0], consecutiveCorrect: 0 });

    // Rep 1: succeed on the drilling center note (the originally-failed note[0]).
    const rep1 = new PracticeAttemptTracker(notes[0]!.frequencyHz, { minDwellTimeMs: 50 });
    rep1.update(voiced(notes[0]!.frequencyHz), 0);
    expect(rep1.update(voiced(notes[0]!.frequencyHz), 50)).toEqual({ status: 'succeeded' });
    controller.reportOutcome('success');

    // Not yet mastered (need 2 consecutive) -- rotated to the neighbor-above.
    state = controller.state;
    expect(state).toMatchObject({ mode: 'drilling', targetNote: notes[1], consecutiveCorrect: 1 });

    // Rep 2: succeed on the rotated note -- this is the 2nd consecutive
    // correct rep, so drilling ends as 'mastered' and hands control back to
    // Playing Practice at centerIndex(0) + 1 = 1, per drilling.ts's documented
    // resume-point policy.
    const rep2 = new PracticeAttemptTracker(notes[1]!.frequencyHz, { minDwellTimeMs: 50 });
    rep2.update(voiced(notes[1]!.frequencyHz), 0);
    expect(rep2.update(voiced(notes[1]!.frequencyHz), 50)).toEqual({ status: 'succeeded' });
    controller.reportOutcome('success');

    expect(controller.state).toEqual({ mode: 'playing-practice', index: 1, targetNote: notes[1] });
  });

  it('changing which strings are included visibly changes the sequence length/content fed to the session', () => {
    const oneString = generatePlayingPracticeSequence({ strings: ['G'] });
    const allStrings = generatePlayingPracticeSequence();

    expect(oneString.length).toBe(5);
    expect(allStrings.length).toBe(20);
    expect(allStrings.map((n) => n.sourceString)).toEqual([
      'G',
      'G',
      'G',
      'G',
      'G',
      'D',
      'D',
      'D',
      'D',
      'D',
      'A',
      'A',
      'A',
      'A',
      'A',
      'E',
      'E',
      'E',
      'E',
      'E',
    ]);

    // Both sequences agree on their first note (both start on open G) but
    // are otherwise materially different -- exactly the "config visibly
    // changes what feeds the UI" property a real config control needs.
    expect(oneString[0]).toEqual(allStrings[0]);
    const oneStringController = new PracticeSessionController(oneString);
    const allStringsController = new PracticeSessionController(allStrings);
    expect(oneStringController.state).toEqual({
      mode: 'playing-practice',
      index: 0,
      targetNote: oneString[0],
    });
    expect(allStringsController.state).toEqual({
      mode: 'playing-practice',
      index: 0,
      targetNote: allStrings[0],
    });
  });

  it('changing the pattern type (open-strings vs. one-octave-scale) visibly changes the note pool for the same string', () => {
    const openStrings = generatePlayingPracticeSequence({
      strings: ['A'],
      patternType: 'open-strings',
    });
    const scale = generatePlayingPracticeSequence({
      strings: ['A'],
      patternType: 'one-octave-scale',
    });

    expect(openStrings.map((n) => n.note.label)).toEqual(['A4']);
    expect(scale.map((n) => n.note.label)).toEqual([
      'A4',
      'B4',
      'C#5',
      'D5',
      'E5',
      'F#5',
      'G#5',
      'A5',
    ]);
  });
});
