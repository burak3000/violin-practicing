import { describe, expect, it } from 'vitest';
import { createMeter } from '../abc/abc-score.js';
import { buildPlayAlongPlan } from './play-along-plan.js';
import type { PlayAlongPlan, PlayAlongPlanOptions } from './play-along-plan.js';
import { DEFAULT_PLAY_ALONG_DETECTION_LAG_MS, PlayAlongSession } from './play-along-session.js';
import type { PlayAlongConfig, PlayAlongNoteResult } from './play-along-session.js';
import { buildTestPiece, consecutiveNotes } from './test-support/piece-builder.js';
import type { BuildPieceOptions, TestNote } from './test-support/piece-builder.js';
import {
  HOP_MS,
  SILENCE,
  allResolved,
  endOfPiece,
  hz,
  performPlan,
  runSession,
  voicedAt,
} from './test-support/frames.js';
import type { PerformanceOptions, Sounding } from './test-support/frames.js';

/** A-major scale from A4, quarter notes at quarter = 60: 1000 ms per note, tolerance 250 ms, dwell 150 ms. */
const SCALE = [69, 71, 73, 74, 76, 78, 80, 81];
const A4 = 69;
const ZERO = 1_000_000;

function setup(
  notes: readonly TestNote[],
  options: {
    piece?: BuildPieceOptions;
    plan?: PlayAlongPlanOptions;
    config?: PlayAlongConfig;
  } = {},
) {
  const plan = buildPlayAlongPlan(buildTestPiece(notes, options.piece), options.plan);
  const session = new PlayAlongSession(plan, options.config);
  return { plan, session };
}

const scalePiece = () => setup(consecutiveNotes(SCALE, 0.25));

function finalResult(session: PlayAlongSession, index: number): PlayAlongNoteResult {
  return session.results[index]!;
}

function hit(result: PlayAlongNoteResult) {
  if (result.status !== 'hit') throw new Error(`expected a hit, got ${JSON.stringify(result)}`);
  return result;
}

function missed(result: PlayAlongNoteResult) {
  if (result.status !== 'missed') throw new Error(`expected a miss, got ${JSON.stringify(result)}`);
  return result;
}

/** Runs a whole performance of `plan` through a session and returns the run. */
function play(
  plan: PlayAlongPlan,
  session: PlayAlongSession,
  performance: PerformanceOptions = {},
) {
  return runSession(session, performPlan(plan, performance), {
    zeroMs: ZERO,
    toMs: endOfPiece(plan),
  });
}

describe('PlayAlongSession: a good performance', () => {
  it('hits every note with an offset near 0 -- a player whose bow lands on the click, seen one detection lag later', () => {
    const { plan, session } = scalePiece();
    const run = play(plan, session);
    for (let i = 0; i < SCALE.length; i++) {
      const result = hit(finalResult(session, i));
      // The first in-tune frame lands within one hop after onset + lag; the lag itself is removed.
      expect(result.timingOffsetMs).toBeGreaterThanOrEqual(0);
      expect(result.timingOffsetMs).toBeLessThan(HOP_MS);
    }
    expect(session.phase).toBe('finished');
    expect(run.updates[run.updates.length - 1]!.finished).toBe(true);
    const summary = session.summary();
    expect(summary).toMatchObject({ total: 8, hits: 8, misses: 0, pending: 0, accuracy: 1 });
    expect(summary.missedIndices).toEqual([]);
    expect(summary.tendency).toBe('steady');
  });

  it('resolves each hit as soon as the dwell is met -- during the note, not at its end', () => {
    const { plan, session } = scalePiece();
    const run = play(plan, session);
    for (let i = 0; i < SCALE.length; i++) {
      const at = run.updates.findIndex((u) => u.resolved.some((r) => r.index === i));
      const t = run.times[at]!;
      const onset = plan.notes[i]!.onsetMs;
      // lag (60) + dwell (150) after the onset, give or take two hops; far before the note's end (+1000).
      expect(t).toBeGreaterThanOrEqual(onset + 60 + 150);
      expect(t).toBeLessThan(onset + 60 + 150 + 2 * HOP_MS);
    }
  });

  it('lists each note in `resolved` of exactly one update, in order', () => {
    const { plan, session } = scalePiece();
    const run = play(plan, session);
    expect(allResolved(run).map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('marks the update that resolves the last note as finished, and keeps reporting finished (nothing resolved again)', () => {
    const { plan, session } = scalePiece();
    const run = play(plan, session);
    const lastResolvedAt = run.updates.findIndex((u) => u.resolved.some((r) => r.index === 7));
    expect(run.updates[lastResolvedAt]!.finished).toBe(true);
    expect(run.updates[lastResolvedAt]!.phase).toBe('finished');
    expect(run.updates[lastResolvedAt - 1]!.finished).toBe(false);
    const after = session.update(voicedAt(hz(A4)), ZERO + plan.totalMs + 5000);
    expect(after).toMatchObject({ phase: 'finished', finished: true });
    expect(after.resolved).toHaveLength(0);
    expect(session.results.filter((r) => r.status === 'hit')).toHaveLength(8);
  });

  it('accepts a note that is a little sharp or flat (within the cents tolerance)', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { perNote: { 2: { cents: 20 }, 5: { cents: -20 } } });
    expect(finalResult(session, 2).status).toBe('hit');
    expect(finalResult(session, 5).status).toBe('hit');
  });

  it('copes with realistic articulation gaps between notes', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { gapMs: 40 });
    expect(session.summary().hits).toBe(8);
  });
});

describe('PlayAlongSession: against a plan with tempo changes, rests and other meters', () => {
  it('follows a mid-piece tempo change (the second bar is twice as fast: shorter notes, tighter tolerance, smaller dwell)', () => {
    const { plan, session } = setup(consecutiveNotes([...SCALE, ...SCALE], 0.25), {
      piece: { tempoMarks: [{ at: 1.0, bpm: 150 }] },
    });
    expect(plan.notes[8]!.onsetMs).toBe(4000 + 4 * 400);
    play(plan, session);
    expect(session.summary().hits).toBe(16);
    // 150 ms late is fine in the slow bar (tolerance 250) but not in the fast one (0.4 * 400 = 160 -> tol 160, shifted by ~6 ms jitter).
    const late = setup(consecutiveNotes([...SCALE, ...SCALE], 0.25), {
      piece: { tempoMarks: [{ at: 1.0, bpm: 150 }] },
    });
    play(late.plan, late.session, { lateMs: 200 });
    expect(late.session.results.slice(0, 4).every((r) => r.status === 'hit')).toBe(true);
    expect(missed(late.session.results[10]!).reason).toBe('late');
  });

  it('scores notes separated by rests (the gap is silence, not an error)', () => {
    const notes: TestNote[] = [
      { midi: 69, startWhole: 0, durationWhole: 0.25 },
      { midi: 71, startWhole: 0.5, durationWhole: 0.25 }, // a quarter rest before it
      { midi: 73, startWhole: 1.0, durationWhole: 0.25 },
    ];
    const { plan, session } = setup(notes);
    play(plan, session, { gapMs: 0 });
    expect(session.summary().hits).toBe(3);
    expect(plan.notes[1]!.onsetMs).toBe(2000);
  });

  it('works in compound time, where the beat is a dotted quarter', () => {
    const eighths = consecutiveNotes([69, 71, 73, 74, 76, 78], 0.125);
    const { plan, session } = setup(eighths, {
      piece: {
        meter: createMeter(6, 8),
        tempo: { beatLengthWhole: 0.375, bpm: 60, text: undefined },
      },
    });
    expect(plan.countInMs).toBe(2000);
    play(plan, session);
    expect(session.summary().hits).toBe(6);
  });
});

describe('PlayAlongSession: lag compensation', () => {
  it('reports ~0 when the frames are delayed by exactly the shift, and -lag when the detector has no delay', () => {
    const noDelay = scalePiece();
    play(noDelay.plan, noDelay.session, { detectionLagMs: 0 });
    for (let i = 0; i < SCALE.length; i++) {
      const offset = hit(finalResult(noDelay.session, i)).timingOffsetMs;
      expect(offset).toBeGreaterThanOrEqual(-DEFAULT_PLAY_ALONG_DETECTION_LAG_MS);
      expect(offset).toBeLessThan(-DEFAULT_PLAY_ALONG_DETECTION_LAG_MS + HOP_MS);
    }
  });

  it('extraLatencyMs shifts the window: frames delayed by lag + extra read 0, frames delayed by the lag alone read early by the extra', () => {
    const delayed = setup(consecutiveNotes(SCALE, 0.25), { config: { extraLatencyMs: 100 } });
    play(delayed.plan, delayed.session, { detectionLagMs: 160 });
    for (let i = 0; i < SCALE.length; i++) {
      const offset = hit(finalResult(delayed.session, i)).timingOffsetMs;
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(HOP_MS);
    }
    const lagOnly = setup(consecutiveNotes(SCALE, 0.25), { config: { extraLatencyMs: 100 } });
    play(lagOnly.plan, lagOnly.session, { detectionLagMs: 60 });
    for (let i = 0; i < SCALE.length; i++) {
      const offset = hit(finalResult(lagOnly.session, i)).timingOffsetMs;
      expect(offset).toBeGreaterThanOrEqual(-100);
      expect(offset).toBeLessThan(-100 + HOP_MS);
    }
  });

  it('a custom detectionLagMs replaces the default', () => {
    const { plan, session } = setup(consecutiveNotes(SCALE, 0.25), {
      config: { detectionLagMs: 30 },
    });
    play(plan, session, { detectionLagMs: 30 });
    const offset = hit(finalResult(session, 3)).timingOffsetMs;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(HOP_MS);
  });
});

describe('PlayAlongSession: timing', () => {
  it('still hits when the player is consistently 120 ms late (quarter = 60: tolerance 250 ms)', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: 120 });
    for (let i = 0; i < SCALE.length; i++) {
      const offset = hit(finalResult(session, i)).timingOffsetMs;
      expect(offset).toBeGreaterThanOrEqual(120);
      expect(offset).toBeLessThan(120 + HOP_MS);
    }
    const summary = session.summary();
    expect(summary.tendency).toBe('late');
    expect(summary.meanOffsetMs).toBeGreaterThan(120);
  });

  it('a player consistently 100 ms early still hits, and is told so', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: -100 });
    expect(session.summary().hits).toBe(8);
    expect(session.summary().tendency).toBe('early');
  });

  it('calls a note played 350 ms late (beyond the tolerance, inside the late window) "late", with the offset', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: 350 });
    for (let i = 0; i < SCALE.length; i++) {
      const result = missed(finalResult(session, i));
      expect(result.reason).toBe('late');
      expect(result.timingOffsetMs).toBeGreaterThanOrEqual(350);
      expect(result.timingOffsetMs).toBeLessThan(350 + HOP_MS);
    }
  });

  it('calls a note that started well before the window "early" (here 400 ms early), even though it is held through the window', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: -400 });
    for (let i = 0; i < SCALE.length; i++) {
      const result = missed(finalResult(session, i));
      expect(result.reason).toBe('early');
      expect(result.timingOffsetMs).toBeGreaterThanOrEqual(-400);
      expect(result.timingOffsetMs).toBeLessThan(-400 + HOP_MS);
    }
  });

  it('still calls it "late" right at the edge of the window (tolerance + dwell = 400 ms late at quarter = 60)', () => {
    // The run starts exactly at the deadline (onset + 60 + 250 + 150); the first frame at or after
    // it both starts the run and decides the note, so the edge is deterministic on any frame grid.
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: 400 });
    for (let i = 0; i < SCALE.length; i++) {
      const result = missed(finalResult(session, i));
      expect(result.reason).toBe('late');
      expect(result.timingOffsetMs).toBeGreaterThanOrEqual(400);
      expect(result.timingOffsetMs).toBeLessThan(400 + HOP_MS);
    }
  });

  it('documents a limit: a note later than tolerance + dwell is never seen in its window, so it reads "not played"', () => {
    // 450 ms late: the note\'s deadline (onset + 460) passes before it sounds (onset + 510).
    const { plan, session } = scalePiece();
    play(plan, session, { lateMs: 450 });
    for (let i = 0; i < SCALE.length; i++) {
      const result = missed(finalResult(session, i));
      expect(result.reason).toBe('not-played');
      expect(result.timingOffsetMs).toBeUndefined();
    }
  });

  it('remembers a late note even when it is too short to count ("late", not "not played")', () => {
    const { session } = setup([{ midi: A4, startWhole: 0, durationWhole: 0.25 }], {
      plan: { countInBeats: 0 },
    });
    // Sounds 40 ms starting 410 ms after the onset: offset +350, shorter than the dwell.
    runSession(session, [{ fromMs: 410, toMs: 450, frequencyHz: hz(A4) }], {
      zeroMs: ZERO,
      fromMs: -800,
      toMs: 1600,
    });
    const result = missed(finalResult(session, 0));
    expect(result.reason).toBe('late');
    expect(result.timingOffsetMs).toBeGreaterThanOrEqual(350);
    expect(result.timingOffsetMs).toBeLessThan(350 + HOP_MS);
  });

  it('scales the tolerance with the beat: at quarter = 200 (300 ms beats, tolerance 120 ms) 150 ms late is a miss', () => {
    const fast = setup(consecutiveNotes(SCALE, 0.25), {
      piece: { tempo: { beatLengthWhole: 0.25, bpm: 200, text: undefined } },
    });
    play(fast.plan, fast.session, { lateMs: 150 });
    expect(missed(finalResult(fast.session, 3)).reason).toBe('late');
    const ok = setup(consecutiveNotes(SCALE, 0.25), {
      piece: { tempo: { beatLengthWhole: 0.25, bpm: 200, text: undefined } },
    });
    play(ok.plan, ok.session, { lateMs: 100 });
    expect(ok.session.summary().hits).toBe(8);
  });

  it('timingToleranceMs overrides the per-note tolerance', () => {
    const strict = setup(consecutiveNotes(SCALE, 0.25), { config: { timingToleranceMs: 50 } });
    play(strict.plan, strict.session, { lateMs: 120 });
    const result = missed(finalResult(strict.session, 2));
    expect(result.reason).toBe('late');
    expect(result.timingOffsetMs).toBeGreaterThanOrEqual(120);

    const lenient = setup(consecutiveNotes(SCALE, 0.25), { config: { timingToleranceMs: 400 } });
    play(lenient.plan, lenient.session, { lateMs: 300 });
    expect(lenient.session.summary().hits).toBe(8);
  });
});

describe('PlayAlongSession: pitch', () => {
  it('a semitone off is a miss with reason "wrong-pitch"; the other notes are unaffected', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { perNote: { 1: { semitones: 1 } } });
    const result = missed(finalResult(session, 1));
    expect(result.reason).toBe('wrong-pitch');
    expect(result.timingOffsetMs).toBeUndefined();
    expect(session.summary().hits).toBe(7);
    expect(session.summary().missedIndices).toEqual([1]);
  });

  it('40 cents sharp is outside the 25-cent tolerance: a miss, "wrong-pitch"', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { perNote: { 3: { cents: 40 } } });
    expect(missed(finalResult(session, 3)).reason).toBe('wrong-pitch');
  });

  it('honours a custom cents tolerance', () => {
    const { plan, session } = setup(consecutiveNotes(SCALE, 0.25), {
      config: { inTuneCentsTolerance: 50 },
    });
    play(plan, session, { perNote: { 3: { cents: 40 } } });
    expect(finalResult(session, 3).status).toBe('hit');
  });

  it('silence is "not-played"', () => {
    const { plan, session } = scalePiece();
    const run = runSession(session, [], { zeroMs: ZERO, toMs: endOfPiece(plan) });
    for (let i = 0; i < SCALE.length; i++) {
      expect(missed(finalResult(session, i)).reason).toBe('not-played');
      expect(missed(finalResult(session, i)).timingOffsetMs).toBeUndefined();
    }
    // Each miss is decided at its deadline: onset + lag + tolerance + dwell = onset + 460.
    for (let i = 0; i < SCALE.length; i++) {
      const at = run.updates.findIndex((u) => u.resolved.some((r) => r.index === i));
      expect(run.times[at]!).toBeGreaterThanOrEqual(i * 1000 + 460);
      expect(run.times[at]!).toBeLessThan(i * 1000 + 460 + HOP_MS);
    }
    expect(session.summary()).toMatchObject({ hits: 0, misses: 8, accuracy: 0 });
  });

  it('a skipped note between two played ones is "not-played", not "wrong-pitch" (the neighbours are not evidence of a wrong note)', () => {
    const { plan, session } = scalePiece();
    play(plan, session, { perNote: { 4: { skip: true } } });
    expect(missed(finalResult(session, 4)).reason).toBe('not-played');
    expect(session.summary().hits).toBe(7);
  });

  it('a wrong note that is neither neighbour is still "wrong-pitch", even next to played notes', () => {
    const { plan, session } = scalePiece();
    // Note 4 (E5) is played as G5 (+3), which is not the neighbouring D5 or F#5.
    play(plan, session, { perNote: { 4: { semitones: 3 } } });
    expect(missed(finalResult(session, 4)).reason).toBe('wrong-pitch');
  });

  it('treats low-confidence and out-of-range readings as unplayed, never as a wrong note', () => {
    const { session } = setup([{ midi: A4, startWhole: 0, durationWhole: 0.25 }], {
      plan: { countInBeats: 0 },
    });
    const sounding: Sounding[] = [
      { fromMs: 60, toMs: 400, frequencyHz: hz(A4 + 1), confidence: 0.3 },
      { fromMs: 400, toMs: 460, frequencyHz: 90 },
    ];
    runSession(session, sounding, { zeroMs: ZERO, fromMs: -800, toMs: 1600 });
    expect(missed(finalResult(session, 0)).reason).toBe('not-played');
  });
});

describe('PlayAlongSession: holding the note', () => {
  const single = () =>
    setup([{ midi: A4, startWhole: 0, durationWhole: 0.25 }], { plan: { countInBeats: 0 } });
  const runSingle = (session: PlayAlongSession, sounding: Sounding[]) =>
    runSession(session, sounding, { zeroMs: ZERO, fromMs: -800, toMs: 1600 });

  it('a run that starts in the window but is shorter than the dwell is a miss', () => {
    const { session } = single();
    runSingle(session, [{ fromMs: 60, toMs: 60 + 140, frequencyHz: hz(A4) }]);
    expect(missed(finalResult(session, 0)).reason).toBe('not-played');
  });

  it('a run just over the dwell is a hit', () => {
    const { session } = single();
    runSingle(session, [{ fromMs: 60, toMs: 60 + 170, frequencyHz: hz(A4) }]);
    expect(finalResult(session, 0).status).toBe('hit');
  });

  it('is strict about continuity: two holds that are each short never add up', () => {
    const { session } = single();
    runSingle(session, [
      { fromMs: 60, toMs: 200, frequencyHz: hz(A4) },
      { fromMs: 220, toMs: 360, frequencyHz: hz(A4) },
    ]);
    expect(missed(finalResult(session, 0)).reason).toBe('not-played');
  });

  it("a dropout in the middle of a hold restarts the run (the hit comes later, at the restart's offset)", () => {
    const { session } = single();
    runSingle(session, [
      { fromMs: 60, toMs: 160, frequencyHz: hz(A4) },
      { fromMs: 160, toMs: 180, frequencyHz: hz(A4), confidence: 0.2 }, // gated out
      { fromMs: 180, toMs: 600, frequencyHz: hz(A4) },
    ]);
    const result = hit(finalResult(session, 0));
    // The run that counts started at ~180 ms, i.e. offset 180 - 60 = 120, not ~0.
    expect(result.timingOffsetMs).toBeGreaterThanOrEqual(120);
    expect(result.timingOffsetMs).toBeLessThan(120 + HOP_MS);
  });

  it('a hold that began before the window can never count, but a separate re-attack inside it can', () => {
    const { session } = single();
    runSingle(session, [
      { fromMs: -340, toMs: -240, frequencyHz: hz(A4) }, // early blip (offset -400)
      { fromMs: 60, toMs: 400, frequencyHz: hz(A4) }, // proper attack
    ]);
    const result = hit(finalResult(session, 0));
    expect(result.timingOffsetMs).toBeGreaterThanOrEqual(0);
    expect(result.timingOffsetMs).toBeLessThan(HOP_MS);
  });

  it('remembers an early note even when it was only a short blip that ended before the window (still "early", with its offset)', () => {
    const { session } = single();
    runSingle(session, [{ fromMs: -340, toMs: -240, frequencyHz: hz(A4) }]);
    const result = missed(finalResult(session, 0));
    expect(result.reason).toBe('early');
    expect(result.timingOffsetMs).toBeGreaterThanOrEqual(-400);
    expect(result.timingOffsetMs).toBeLessThan(-400 + HOP_MS);
  });

  it('never asks for less than 40 ms of hold, however short the note (a 1/64 note is 62.5 ms at quarter = 60)', () => {
    const tiny = () =>
      setup([{ midi: A4, startWhole: 0, durationWhole: 1 / 64 }], { plan: { countInBeats: 0 } });
    const runAtOneMs = (session: PlayAlongSession, toMs: number) =>
      runSession(session, [{ fromMs: 60, toMs, frequencyHz: hz(A4) }], {
        zeroMs: ZERO,
        fromMs: -800,
        toMs: 1600,
        hopMs: 1,
      });
    const short = tiny(); // frames 60..98: a 38 ms run -- over 60% of the note (37.5) but under the 40 ms floor
    runAtOneMs(short.session, 99);
    expect(short.session.results[0]!.status).toBe('missed');
    const enough = tiny();
    runAtOneMs(enough.session, 101); // a 40 ms run
    expect(enough.session.results[0]!.status).toBe('hit');
  });

  it('a hold that began before the window and never lets go does not count', () => {
    const { session } = single();
    runSingle(session, [{ fromMs: -400, toMs: 900, frequencyHz: hz(A4) }]);
    const result = missed(finalResult(session, 0));
    expect(result.reason).toBe('early');
    expect(result.timingOffsetMs).toBeLessThan(-250);
  });

  it('scores a fast note by its own length: a sixteenth at quarter = 100 needs only 90 ms (60% of 150), not 150', () => {
    const sixteenths = consecutiveNotes([69, 71, 73, 74, 76, 78, 80, 81, 83, 85, 86, 88], 1 / 16);
    const make = () =>
      setup(sixteenths, { piece: { tempo: { beatLengthWhole: 0.25, bpm: 100, text: undefined } } });

    const crisp = make();
    play(crisp.plan, crisp.session, { gapMs: 20 }); // each note sounds 130 ms
    expect(crisp.session.summary().hits).toBe(12);

    const short = make();
    play(short.plan, short.session, { gapMs: 40 }); // 110 ms: still over 90
    expect(short.session.summary().hits).toBe(12);

    const clipped = make();
    play(clipped.plan, clipped.session, { gapMs: 80 }); // 70 ms: under 90
    expect(clipped.session.summary().hits).toBe(0);
  });

  it('minDwellTimeMs caps the dwell: a 100 ms cap lets a 120 ms hold of a long note count', () => {
    const capped = setup([{ midi: A4, startWhole: 0, durationWhole: 0.25 }], {
      plan: { countInBeats: 0 },
      config: { minDwellTimeMs: 100 },
    });
    runSession(capped.session, [{ fromMs: 60, toMs: 180, frequencyHz: hz(A4) }], {
      zeroMs: ZERO,
      fromMs: -800,
      toMs: 1600,
    });
    expect(capped.session.results[0]!.status).toBe('hit');
  });
});

describe('PlayAlongSession: repeated pitch', () => {
  const REPEATS = [69, 69, 69, 71];

  it('one pitch held straight through "A A A" earns credit for each note, exactly on the beat', () => {
    const { plan, session } = setup(consecutiveNotes(REPEATS, 0.25));
    // The A is held continuously from the first note's onset until the last A ends.
    const sounding: Sounding[] = [
      { fromMs: 60, toMs: 3060, frequencyHz: hz(69) },
      { fromMs: 3060, toMs: 4060, frequencyHz: hz(71) },
    ];
    const run = runSession(session, sounding, { zeroMs: ZERO, toMs: endOfPiece(plan) });
    expect(hit(finalResult(session, 0)).timingOffsetMs).toBeLessThan(HOP_MS);
    expect(hit(finalResult(session, 1)).timingOffsetMs).toBe(0);
    expect(hit(finalResult(session, 2)).timingOffsetMs).toBe(0);
    expect(finalResult(session, 3).status).toBe('hit');
    // Credit arrives one dwell after the onset (+ lag), not before.
    const at = run.updates.findIndex((u) => u.resolved.some((r) => r.index === 1));
    expect(run.times[at]!).toBeGreaterThanOrEqual(1000 + 60 + 150);
    expect(run.times[at]!).toBeLessThan(1000 + 60 + 150 + HOP_MS);
  });

  it('re-articulated repeats (a short dropout at each bow change) hit with offsets near 0', () => {
    const { plan, session } = setup(consecutiveNotes(REPEATS, 0.25));
    play(plan, session, { gapMs: 40 });
    for (let i = 0; i < REPEATS.length; i++) {
      const offset = hit(finalResult(session, i)).timingOffsetMs;
      expect(Math.abs(offset)).toBeLessThan(HOP_MS);
    }
  });

  it('does not give the leniency to a different pitch: "A B" with A held through B\'s window is not a B', () => {
    const { plan, session } = setup(consecutiveNotes([69, 71], 0.25));
    runSession(session, [{ fromMs: 60, toMs: 2060, frequencyHz: hz(69) }], {
      zeroMs: ZERO,
      toMs: endOfPiece(plan),
    });
    expect(finalResult(session, 0).status).toBe('hit');
    expect(missed(finalResult(session, 1)).reason).toBe('not-played');
  });

  it('a repeated note that is simply not played again is still a miss', () => {
    const { plan, session } = setup(consecutiveNotes([69, 69, 71], 0.25));
    runSession(
      session,
      [
        { fromMs: 60, toMs: 1060, frequencyHz: hz(69) }, // first A only, for its own length
        { fromMs: 2060, toMs: 3060, frequencyHz: hz(71) },
      ],
      { zeroMs: ZERO, toMs: endOfPiece(plan) },
    );
    expect(finalResult(session, 0).status).toBe('hit');
    expect(missed(finalResult(session, 1)).reason).toBe('not-played');
    expect(finalResult(session, 2).status).toBe('hit');
  });
});

describe('PlayAlongSession: phases, position and clocks', () => {
  it('is idle before start: frames are ignored, nothing is scored', () => {
    const { plan, session } = scalePiece();
    const update = session.update(voicedAt(hz(69)), ZERO + 100);
    expect(update).toMatchObject({ phase: 'idle', finished: false, dwellFraction: 0 });
    expect(update.resolved).toHaveLength(0);
    expect(update.nextNoteIndex).toBe(0);
    expect(session.phase).toBe('idle');
    expect(session.zeroMs).toBeUndefined();
    expect(session.results.every((r) => r.status === 'pending')).toBe(true);
    expect(session.results).toHaveLength(plan.notes.length);
  });

  it('moves count-in -> playing at time 0 and tracks beats and the due / next note', () => {
    const { plan, session } = scalePiece();
    session.start(ZERO);
    expect(session.zeroMs).toBe(ZERO);
    expect(session.phase).toBe('count-in');
    const at = (t: number) => session.update(SILENCE, ZERO + t);

    const first = at(-4000);
    expect(first).toMatchObject({ phase: 'count-in', timeMs: -4000, beatIndex: 0 });
    expect(first.dueNoteIndex).toBeUndefined();
    expect(first.nextNoteIndex).toBe(0);
    expect(first.positionWhole).toBeCloseTo(-1, 9);

    expect(at(-3500).beatIndex).toBe(0);
    expect(at(-3000).beatIndex).toBe(1);
    const lastCountIn = at(-1);
    expect(lastCountIn).toMatchObject({ phase: 'count-in', beatIndex: 3 });

    const downbeat = at(0);
    expect(downbeat).toMatchObject({
      phase: 'playing',
      timeMs: 0,
      beatIndex: 4,
      dueNoteIndex: 0,
      nextNoteIndex: 1,
    });
    expect(downbeat.positionWhole).toBe(0);

    const mid = at(2500);
    expect(mid).toMatchObject({ beatIndex: 6, dueNoteIndex: 2, nextNoteIndex: 3 });
    expect(mid.positionWhole).toBeCloseTo(0.625, 9);

    const end = at(plan.totalMs - 1);
    expect(end.dueNoteIndex).toBe(7);
    expect(end.nextNoteIndex).toBeUndefined();
  });

  it('starts directly in "playing" when there is no count-in', () => {
    const { session } = setup(consecutiveNotes(SCALE, 0.25), { plan: { countInBeats: 0 } });
    session.start(ZERO);
    expect(session.phase).toBe('playing');
    expect(session.update(SILENCE, ZERO).beatIndex).toBe(0);
  });

  it('beatIndex is -1 before the first beat', () => {
    const { session } = scalePiece();
    session.start(ZERO);
    expect(session.update(SILENCE, ZERO - 5000).beatIndex).toBe(-1);
  });

  it('works on any clock origin (epoch ms or a small performance.now()-style value)', () => {
    for (const zero of [1_760_000_000_000, 5_250.5]) {
      const { plan, session } = scalePiece();
      const sounding = performPlan(plan);
      runSession(session, sounding, { zeroMs: zero, toMs: endOfPiece(plan) });
      expect(session.summary().hits).toBe(8);
    }
  });

  it('start() resets everything for another run', () => {
    const { plan, session } = scalePiece();
    play(plan, session);
    expect(session.summary().hits).toBe(8);
    session.start(ZERO + 99_999);
    expect(session.phase).toBe('count-in');
    expect(session.results.every((r) => r.status === 'pending')).toBe(true);
    expect(session.summary()).toMatchObject({ hits: 0, pending: 8 });
    runSession(session, performPlan(plan), {
      zeroMs: ZERO + 99_999,
      toMs: endOfPiece(plan),
      start: false,
    });
    expect(session.summary().hits).toBe(8);
  });

  it('a piece with no notes is finished at once', () => {
    const { session } = setup([], { piece: { totalWhole: 0 } });
    session.start(ZERO);
    expect(session.phase).toBe('finished');
    const update = session.update(SILENCE, ZERO);
    expect(update).toMatchObject({ phase: 'finished', finished: true });
    expect(session.summary()).toMatchObject({ total: 0, hits: 0, accuracy: 0 });
  });
});

describe('PlayAlongSession: robustness', () => {
  it('ignores a frame older than the previous one: the latest update comes back, with nothing newly resolved', () => {
    const fresh = scalePiece();
    const sounding = performPlan(fresh.plan);
    // Feed up to the first hit, then replay an older timestamp.
    fresh.session.start(ZERO);
    let last = fresh.session.update(SILENCE, ZERO - 4000);
    for (let t = -4000; t <= 400; t += HOP_MS) {
      last = fresh.session.update(
        sounding.some((s) => t >= s.fromMs && t < s.toMs) ? voicedAt(hz(69)) : SILENCE,
        ZERO + t,
      );
      if (last.resolved.length > 0) break;
    }
    expect(last.resolved).toHaveLength(1); // note 0 just resolved
    const stale = fresh.session.update(voicedAt(hz(40)), ZERO + last.timeMs - 500);
    expect(stale.timeMs).toBe(last.timeMs);
    expect(stale.resolved).toHaveLength(0);
    expect(stale.phase).toBe(last.phase);
    expect(fresh.session.results[0]!.status).toBe('hit');
    // And the stream carries on normally afterwards.
    const next = fresh.session.update(voicedAt(hz(69)), ZERO + last.timeMs + HOP_MS);
    expect(next.timeMs).toBeCloseTo(last.timeMs + HOP_MS, 9);
  });

  it('ignores non-finite timestamps and malformed readings without throwing', () => {
    const { session } = scalePiece();
    session.start(ZERO);
    session.update(SILENCE, ZERO);
    expect(() => session.update(SILENCE, Number.NaN)).not.toThrow();
    expect(() => session.update(SILENCE, Number.POSITIVE_INFINITY)).not.toThrow();
    expect(() => session.update(undefined as never, ZERO + 20)).not.toThrow();
    expect(() =>
      session.update({ voiced: true, frequencyHz: Number.NaN, confidence: 1 }, ZERO + 40),
    ).not.toThrow();
    expect(session.update(SILENCE, ZERO + 60).timeMs).toBe(60);
  });

  it('accepts frames with equal timestamps (non-decreasing, not strictly increasing)', () => {
    const { session } = scalePiece();
    session.start(ZERO);
    session.update(SILENCE, ZERO + 100);
    expect(session.update(SILENCE, ZERO + 100).timeMs).toBe(100);
  });

  it('resolves several notes in one update when frames are sparse, in index order', () => {
    const { session } = setup(consecutiveNotes([69, 71, 73], 0.25));
    session.start(ZERO);
    session.update(SILENCE, ZERO - 100);
    const jump = session.update(SILENCE, ZERO + 20_000);
    expect(jump.resolved.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(jump.finished).toBe(true);
  });

  it('stop() ends the run: unresolved notes stay pending and later frames score nothing', () => {
    const { plan, session } = scalePiece();
    runSession(session, performPlan(plan), { zeroMs: ZERO, toMs: 3500 });
    session.stop();
    expect(session.phase).toBe('finished');
    expect(session.results.slice(0, 4).every((r) => r.status === 'hit')).toBe(true);
    expect(session.results.slice(4).every((r) => r.status === 'pending')).toBe(true);
    const summary = session.summary();
    expect(summary).toMatchObject({ total: 8, hits: 4, misses: 0, pending: 4, accuracy: 0.5 });
    const after = session.update(voicedAt(hz(76)), ZERO + 4500);
    expect(after).toMatchObject({ phase: 'finished', finished: true });
    expect(after.resolved).toHaveLength(0);
    expect(session.results[4]!.status).toBe('pending');
  });

  it('stop() before start leaves an unstarted session finished and harmless', () => {
    const { session } = scalePiece();
    session.stop();
    expect(session.phase).toBe('finished');
    expect(session.update(SILENCE, 0).resolved).toHaveLength(0);
    session.start(ZERO);
    expect(session.phase).toBe('count-in');
  });

  it('validates its configuration and start argument', () => {
    const { plan } = scalePiece();
    expect(() => new PlayAlongSession(plan, { detectionLagMs: -1 })).toThrow(RangeError);
    expect(() => new PlayAlongSession(plan, { detectionLagMs: Number.NaN })).toThrow(RangeError);
    expect(() => new PlayAlongSession(plan, { extraLatencyMs: -5 })).toThrow(RangeError);
    expect(() => new PlayAlongSession(plan, { timingToleranceMs: 0 })).toThrow(RangeError);
    expect(() => new PlayAlongSession(plan, { minDwellTimeMs: 0 })).toThrow(RangeError);
    expect(() => new PlayAlongSession(plan, { minDwellTimeMs: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    const session = new PlayAlongSession(plan);
    expect(() => session.start(Number.NaN)).toThrow(RangeError);
    expect(() => session.start(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(
      () => new PlayAlongSession(plan, { detectionLagMs: 0, extraLatencyMs: 0 }),
    ).not.toThrow();
  });

  it('stays fast on a long piece (work is proportional to the notes in play, not the piece)', () => {
    const midis = Array.from({ length: 1000 }, (_, i) => 60 + ((i * 7) % 24));
    const { plan, session } = setup(consecutiveNotes(midis, 0.25), {
      piece: { tempo: { beatLengthWhole: 0.25, bpm: 240, text: undefined } },
    });
    const started = performance.now();
    runSession(session, performPlan(plan), { zeroMs: ZERO, toMs: endOfPiece(plan) });
    const elapsed = performance.now() - started;
    expect(session.summary().hits).toBe(1000);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('PlayAlongSession: dwellFraction', () => {
  const single = () =>
    setup([{ midi: A4, startWhole: 0, durationWhole: 0.25 }], { plan: { countInBeats: 0 } });

  it('rises from 0 to 1 over the hold and is 1 on the update that resolves the hit', () => {
    const { session } = single();
    session.start(ZERO);
    const frame = (t: number) => session.update(voicedAt(hz(A4)), ZERO + t);
    expect(session.update(SILENCE, ZERO - 100).dwellFraction).toBe(0);
    expect(frame(60).dwellFraction).toBe(0);
    expect(frame(135).dwellFraction).toBeCloseTo(0.5, 6);
    expect(frame(180).dwellFraction).toBeCloseTo(0.8, 6);
    const done = frame(210);
    expect(done.resolved).toHaveLength(1);
    expect(done.dwellFraction).toBe(1);
  });

  it('is 0 when nothing is in tune, and a hold that started before the window shows nothing (it cannot score)', () => {
    const { session } = single();
    session.start(ZERO);
    expect(session.update(SILENCE, ZERO - 300).dwellFraction).toBe(0);
    const early = [-460, -400, -300, -200, -100].map(
      (t) => session.update(voicedAt(hz(A4)), ZERO + t).dwellFraction,
    );
    expect(early).toEqual([0, 0, 0, 0, 0]);
    expect(session.update(SILENCE, ZERO - 50).dwellFraction).toBe(0);
  });

  it('shows the best hold when several notes are in play', () => {
    const { session } = setup(consecutiveNotes([69, 71], 1 / 16), {
      piece: { tempo: { beatLengthWhole: 0.25, bpm: 100, text: undefined } },
      plan: { countInBeats: 0 },
    });
    session.start(ZERO);
    // Note 0 (sixteenth, 150 ms): dwell 90 ms. 45 ms into the hold -> 0.5.
    session.update(voicedAt(hz(69)), ZERO + 60);
    expect(session.update(voicedAt(hz(69)), ZERO + 105).dwellFraction).toBeCloseTo(0.5, 6);
  });
});
