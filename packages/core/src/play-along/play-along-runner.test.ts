import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import type { AbcPiece } from '../abc/abc-score.js';
import { analyzeTunerReading } from '../tuner/finger-tuner.js';
import {
  DEFAULT_PLAY_ALONG_LEAD_MS,
  PlayAlongRunner,
  notesAtIndices,
} from './play-along-runner.js';
import { HOP_MS, hz, performPlan, readingAt, type Sounding } from './test-support/frames.js';
import { buildTestPiece, consecutiveNotes } from './test-support/piece-builder.js';

/** Four quarter notes C4 D4 E4 F4 at 60 bpm = 1000 ms each, with a four-beat count-in. */
function fourQuarters(): AbcPiece {
  return buildTestPiece(consecutiveNotes([60, 62, 64, 65], 0.25));
}

/** A hand-driven clock, click log and (manual) timer. */
function harness(
  piece: AbcPiece,
  options: { click?: boolean; tempoBpm?: number; countInBeats?: number } = {},
) {
  const clock = { now: 100_000 };
  const clicks: Array<{ atMs: number; accent: boolean }> = [];
  let tick: (() => void) | undefined;
  const runner = new PlayAlongRunner({
    piece,
    tempoBpm: options.tempoBpm ?? piece.tempo.bpm,
    countInBeats: options.countInBeats ?? piece.meter.beatsPerBar,
    nowMs: () => clock.now,
    ...(options.click === false
      ? {}
      : { click: (atMs: number, accent: boolean) => clicks.push({ atMs, accent }) }),
    setIntervalFn: (callback) => {
      tick = callback;
      return 1;
    },
    clearIntervalFn: () => {
      tick = undefined;
    },
  });

  /** Feeds frames for a performance up to plan time `toMs`, advancing the clock with them. */
  const play = (sounding: readonly Sounding[], toMs: number, fromMs = -runner.plan.countInMs) => {
    for (let t = fromMs; t <= toMs; t += HOP_MS) {
      clock.now = runner.zeroMs + t;
      const reading = readingAt(sounding, t);
      runner.handleFrame(reading, analyzeTunerReading(reading), runner.zeroMs + t);
      tick?.();
    }
  };
  return { runner, clock, clicks, play, tick: () => tick?.() };
}

describe('PlayAlongRunner: a perfect run', () => {
  it('judges every note on time, finishes by itself and summarizes', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.play(performPlan(h.runner.plan), h.runner.plan.totalMs + 1500);

    expect(h.runner.phase).toBe('finished');
    expect(h.runner.completed).toBe(true);
    const view = h.runner.getView();
    expect(view.phase).toBe('finished');
    expect(view.noteStates).toEqual(['hit', 'hit', 'hit', 'hit']);
    expect(view.summary).toMatchObject({
      headline: '4 of 4 notes on time (100%)',
      hits: 4,
      total: 4,
      complete: true,
      missedNoteIndices: [],
    });
    expect(view.summary?.misses).toEqual([]);
  });

  it('lists the missed notes with where they are and what went wrong', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const sounding = performPlan(h.runner.plan, {
      perNote: { 1: { skip: true }, 2: { semitones: -3 } },
    });
    h.play(sounding, h.runner.plan.totalMs + 1500);

    const view = h.runner.getView();
    expect(view.noteStates).toEqual(['hit', 'missed', 'missed', 'hit']);
    expect(view.summary?.headline).toBe('2 of 4 notes on time (50%)');
    expect(view.summary?.missedNoteIndices).toEqual([1, 2]);
    expect(view.summary?.misses).toEqual([
      { noteIndex: 1, text: 'Bar 1, beat 2 · D4 — not played' },
      { noteIndex: 2, text: 'Bar 1, beat 3 · E4 — played the wrong note' },
    ]);
  });
});

describe('PlayAlongRunner: the clock and the view', () => {
  it('starts the first count-in click leadMs after start() and the music after the count-in', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    expect(h.runner.zeroMs).toBe(100_000 + DEFAULT_PLAY_ALONG_LEAD_MS + 4000);
    const view = h.runner.getView();
    expect(view.phase).toBe('count-in');
    expect(view.timeMs).toBeCloseTo(-4000 - DEFAULT_PLAY_ALONG_LEAD_MS, 6);
    expect(view.countInRemaining).toBe(4);
    expect(view.beat).toBeUndefined();
  });

  it('counts in 4, 3, 2, 1, then plays, driven by the platform clock alone', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const at = (ms: number) => {
      h.clock.now = h.runner.zeroMs + ms;
      return h.runner.getView();
    };
    expect(at(-4000).countInRemaining).toBe(4);
    expect(at(-4000).beat).toMatchObject({ inBar: 1, accent: true, beatsPerBar: 4 });
    expect(at(-2500).countInRemaining).toBe(3);
    expect(at(-2500).beat).toMatchObject({ inBar: 2, accent: false });
    expect(at(-1500).countInRemaining).toBe(2);
    expect(at(-1000).countInRemaining).toBe(1);
    expect(at(-500).countInRemaining).toBe(1);
    expect(at(-500).beat?.progress).toBeCloseTo(0.5, 6);
    const playing = at(0);
    expect(playing.phase).toBe('playing');
    expect(playing.countInRemaining).toBeUndefined();
    expect(playing.beat).toMatchObject({ inBar: 1, accent: true });
  });

  it('puts the playhead at the music position (whole notes), negative in the count-in', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.clock.now = h.runner.zeroMs + 500;
    expect(h.runner.getView().positionWhole).toBeCloseTo(0.125, 9);
    h.clock.now = h.runner.zeroMs - 1000;
    expect(h.runner.getView().positionWhole).toBeCloseTo(-0.25, 9);
  });

  it('shows the tempo as written and as adjusted', () => {
    const asWritten = harness(fourQuarters());
    expect(asWritten.runner.getView().tempoText).toBe('♩ = 60');
    const slower = harness(fourQuarters(), { tempoBpm: 45 });
    expect(slower.runner.getView().tempoText).toBe('♩ = 45');
    // Slower tempo => longer notes.
    expect(slower.runner.plan.notes[1]!.onsetMs).toBeCloseTo(1000 * (60 / 45), 6);
  });

  it('is idle before start() and ignores frames', () => {
    const h = harness(fourQuarters());
    expect(h.runner.getView().phase).toBe('idle');
    h.runner.handleFrame(
      { voiced: true, frequencyHz: 262, confidence: 1 },
      analyzeTunerReading({ voiced: true, frequencyHz: 262, confidence: 1 }),
      0,
    );
    expect(h.runner.getView().noteStates).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('does not start twice', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const zero = h.runner.zeroMs;
    h.clock.now += 5000;
    h.runner.start();
    expect(h.runner.zeroMs).toBe(zero);
  });

  it('names the target note and previews the next ones in the sheet spelling', () => {
    const h = harness(buildTestPiece(consecutiveNotes([70, 72, 74, 75, 77, 79], 0.25)));
    h.runner.start();
    h.clock.now = h.runner.zeroMs - 100;
    // Before the first onset the target is the first note; the previews follow it.
    expect(h.runner.getView().targetLabel).toBe('A\u266f4');
    expect(h.runner.getView().upcomingLabels).toEqual(['C5', 'D5', 'D\u266f5', 'F5']);
  });
});

describe('PlayAlongRunner: note states', () => {
  it('moves "due" along with the music and keeps the array identity when nothing changes', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const sounding = performPlan(h.runner.plan);
    h.play(sounding, -10);
    const before = h.runner.getView();
    expect(before.dueNoteIndex).toBeUndefined();
    expect(before.noteStates).toEqual(['pending', 'pending', 'pending', 'pending']);

    // Just past the first onset, before the first note is judged: it is "due".
    h.play(sounding, 20, -10);
    const due = h.runner.getView();
    expect(due.dueNoteIndex).toBe(0);
    expect(due.noteStates[0]).toBe('due');
    expect(due.noteStatesVersion).toBeGreaterThan(before.noteStatesVersion);

    // Frames that change nothing keep the same array and version.
    const sameArray = h.runner.getView().noteStates;
    const sameVersion = h.runner.getView().noteStatesVersion;
    h.play(sounding, 30, 22);
    expect(h.runner.getView().noteStates).toBe(sameArray);
    expect(h.runner.getView().noteStatesVersion).toBe(sameVersion);
  });

  it('goes straight from pending to hit/missed when judged, never back', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const sounding = performPlan(h.runner.plan, { perNote: { 0: { skip: true } } });
    const seen: string[] = [];
    for (let t = -h.runner.plan.countInMs; t <= 2600; t += HOP_MS) {
      h.clock.now = h.runner.zeroMs + t;
      const reading = readingAt(sounding, t);
      h.runner.handleFrame(reading, analyzeTunerReading(reading), h.runner.zeroMs + t);
      seen.push(h.runner.getView().noteStates[0]!);
    }
    const collapsed = seen.filter((state, i) => i === 0 || state !== seen[i - 1]);
    expect(collapsed).toEqual(['pending', 'due', 'missed']);
  });
});

describe('PlayAlongRunner: live feedback', () => {
  it('reports what is heard against the note being played, with flats for a flat key', () => {
    const tune = parseAbc('X:1\nM:4/4\nL:1/4\nQ:1/4=60\nK:F\nB c d e |]\n').tunes[0]!;
    const built = buildAbcPracticeSequence(tune);
    if (built.status !== 'ok') throw new Error('expected ok');
    const h = harness(built.piece);
    h.runner.start();
    // Play the first note (B-flat) 8 cents sharp, in time.
    const sounding: Sounding[] = [{ fromMs: 60, toMs: 900, frequencyHz: hz(70, 8) }];
    h.play(sounding, 400);
    expect(h.runner.getView().liveFeedbackText).toBe('Hearing B♭4 (+8c from target)');
  });

  it('compares a player who is exactly on the beat with the right note for the whole note (the detector lag is allowed for)', () => {
    // C4 D4 E4 F4, 1000 ms each. A perfect player's detector reports each note 60 ms after its beat,
    // so a naive "nearest onset to now" would switch to the next note ~500 ms in and, for the first
    // 60 ms of every following note, still compare against the one before.
    const h = harness(fourQuarters());
    h.runner.start();
    const sounding = performPlan(h.runner.plan);
    const seen: Array<{ t: number; text: string }> = [];
    for (let t = -h.runner.plan.countInMs; t <= 3500; t += HOP_MS) {
      h.clock.now = h.runner.zeroMs + t;
      const reading = readingAt(sounding, t);
      h.runner.handleFrame(reading, analyzeTunerReading(reading), h.runner.zeroMs + t);
      seen.push({ t, text: h.runner.getView().liveFeedbackText });
    }
    const hearing = seen.filter((s) => s.text.startsWith('Hearing'));
    expect(hearing.length).toBeGreaterThan(100);
    // A perfect, in-tune player is never reported far from the target.
    for (const { text } of hearing) {
      expect(text).toMatch(/\((\+|-)(0|1|2)c from target\)/);
    }
  });

  it('says so when there is no signal or it is unclear', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.play([], 200);
    expect(h.runner.getView().liveFeedbackText).toBe('No signal');
    const noisy: Sounding[] = [{ fromMs: 0, toMs: 5000, frequencyHz: hz(60), confidence: 0.2 }];
    h.play(noisy, 400, 210);
    expect(h.runner.getView().liveFeedbackText).toBe('Unclear signal…');
  });
});

describe('PlayAlongRunner: stopping and lost signal', () => {
  it('stop() ends the run with a partial summary: unreached notes are not counted as missed', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const sounding = performPlan(h.runner.plan);
    h.play(sounding, 1500); // first note judged, second in progress
    h.runner.stop();
    expect(h.runner.phase).toBe('finished');
    expect(h.runner.completed).toBe(false);
    const view = h.runner.getView();
    expect(view.summary?.complete).toBe(false);
    expect(view.summary?.hits).toBeGreaterThanOrEqual(1);
    expect(view.summary?.misses).toEqual([]);
    expect(view.summary?.headline).toContain('not reached');
  });

  it('stop() freezes the display time and is safe to repeat', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.clock.now = h.runner.zeroMs + 500;
    h.runner.stop();
    const frozen = h.runner.getView().timeMs;
    h.clock.now += 10_000;
    expect(h.runner.getView().timeMs).toBe(frozen);
    h.runner.stop();
    expect(h.runner.getView().phase).toBe('finished');
  });

  it('flags a lost signal when no analysis frame arrives for a while, and clears it when one does', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    const silent = { voiced: false, frequencyHz: 0, confidence: 0 };
    h.clock.now = h.runner.zeroMs + 100;
    h.runner.handleFrame(silent, analyzeTunerReading(silent), h.clock.now);
    h.clock.now = h.runner.zeroMs + 600;
    expect(h.runner.getView().signalLost).toBe(false);
    h.clock.now = h.runner.zeroMs + 2500;
    expect(h.runner.getView().signalLost).toBe(true);
    h.runner.handleFrame(silent, analyzeTunerReading(silent), h.clock.now);
    expect(h.runner.getView().signalLost).toBe(false);
  });

  it('also notices during the count-in that no frames are arriving (capture was never started)', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.clock.now += 1000;
    expect(h.runner.getView().signalLost).toBe(false);
    h.clock.now += 1000;
    expect(h.runner.getView().signalLost).toBe(true);
  });
});

describe('PlayAlongRunner: the click', () => {
  it('hands every beat of the plan to the click sink at the right clock time, accents included', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    // Drive the scheduler's timer until the end of the plan has passed.
    for (let t = -h.runner.plan.countInMs; t <= h.runner.plan.totalMs + 200; t += 20) {
      h.clock.now = h.runner.zeroMs + t;
      h.tick();
    }
    const expected = h.runner.plan.beats.map((b) => ({
      atMs: h.runner.zeroMs + b.tMs,
      accent: b.accent,
    }));
    expect(h.clicks).toEqual(expected);
    // 4 count-in beats + 4 music beats, accented on the 1 of each bar.
    expect(h.clicks.map((c) => c.accent)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it('plays no clicks when no sink is given', () => {
    const h = harness(fourQuarters(), { click: false });
    h.runner.start();
    h.tick();
    expect(h.clicks).toEqual([]);
  });

  it('stops clicking when the run is stopped', () => {
    const h = harness(fourQuarters());
    h.runner.start();
    h.clock.now = h.runner.zeroMs - 3000;
    h.tick();
    const soFar = h.clicks.length;
    h.runner.stop();
    h.clock.now = h.runner.zeroMs + 3000;
    h.tick();
    expect(h.clicks.length).toBe(soFar);
  });
});

describe('PlayAlongRunner with a parsed piece', () => {
  it('runs a pickup piece in 3/4 end to end', () => {
    const tune = parseAbc('X:1\nM:3/4\nL:1/4\nQ:1/4=120\nK:G\nD | G2 A | B2 c | d3 |]\n').tunes[0]!;
    const built = buildAbcPracticeSequence(tune);
    if (built.status !== 'ok') throw new Error('expected ok');
    const h = harness(built.piece);
    h.runner.start();
    expect(h.runner.plan.notes).toHaveLength(6);
    expect(h.runner.plan.notes[0]).toMatchObject({ barNumber: 0, beatInBar: 3 });
    h.play(performPlan(h.runner.plan), h.runner.plan.totalMs + 1500);
    expect(h.runner.getView().summary?.headline).toBe('6 of 6 notes on time (100%)');
    // A pickup bar reads "Pickup".
    expect(h.runner.getView().phase).toBe('finished');
  });

  it('builds a practice list from just the missed notes', () => {
    const piece = fourQuarters();
    const notes = notesAtIndices(piece, [1, 3]);
    expect(notes.map((n) => n.note.label)).toEqual(['D4', 'F4']);
    expect(notesAtIndices(piece, [9, 0]).map((n) => n.note.label)).toEqual(['C4']);
  });
});
