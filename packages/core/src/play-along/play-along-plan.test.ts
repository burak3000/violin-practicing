import { describe, expect, it } from 'vitest';
import { createMeter } from '../abc/abc-score.js';
import type { AbcPiece } from '../abc/abc-score.js';
import { MAX_PLAN_BEATS, buildPlayAlongPlan } from './play-along-plan.js';
import { buildTestPiece, consecutiveNotes } from './test-support/piece-builder.js';

const A4 = 69;
const quarters = (count: number, start = 0) =>
  consecutiveNotes(
    Array.from({ length: count }, () => A4),
    0.25,
    start,
  );

/** Beats as a compact table for readable assertions. */
function beatTable(piece: AbcPiece, options?: Parameters<typeof buildPlayAlongPlan>[1]) {
  const plan = buildPlayAlongPlan(piece, options);
  return plan.beats.map((b) => ({
    t: Math.round(b.tMs),
    ci: b.countIn,
    acc: b.accent,
    beat: b.beatInBar,
    bar: b.barNumber,
  }));
}

describe('buildPlayAlongPlan: 4/4 beat grid and count-in', () => {
  const piece = buildTestPiece(quarters(8)); // 2 bars of quarters at quarter = 60

  it('counts in one bar (4 clicks, first accented) before the music, then clicks every beat', () => {
    const plan = buildPlayAlongPlan(piece);
    expect(plan.countInMs).toBe(4000);
    expect(plan.totalMs).toBe(8000);
    expect(plan.beats).toHaveLength(4 + 8);
    expect(beatTable(piece)).toEqual([
      { t: -4000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -3000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: -2000, ci: true, acc: false, beat: 3, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 4, bar: 0 },
      { t: 0, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 1000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 2000, ci: false, acc: false, beat: 3, bar: 1 },
      { t: 3000, ci: false, acc: false, beat: 4, bar: 1 },
      { t: 4000, ci: false, acc: true, beat: 1, bar: 2 },
      { t: 5000, ci: false, acc: false, beat: 2, bar: 2 },
      { t: 6000, ci: false, acc: false, beat: 3, bar: 2 },
      { t: 7000, ci: false, acc: false, beat: 4, bar: 2 },
    ]);
  });

  it('puts a beat that falls exactly on 0 in the music (not the count-in), coinciding with the first note', () => {
    const plan = buildPlayAlongPlan(piece);
    const firstMusicBeat = plan.beats.find((b) => !b.countIn)!;
    expect(firstMusicBeat.tMs).toBe(0);
    expect(plan.notes[0]!.onsetMs).toBe(0);
    expect(plan.beats.filter((b) => b.countIn).every((b) => b.tMs < 0)).toBe(true);
  });

  it('lists count-in beats first, ascending, then music beats ascending', () => {
    const times = buildPlayAlongPlan(piece).beats.map((b) => b.tMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('does not click at the very end of the music (a beat exactly at totalWhole is outside it)', () => {
    const plan = buildPlayAlongPlan(piece);
    expect(plan.beats[plan.beats.length - 1]!.tMs).toBe(7000);
  });
});

describe('buildPlayAlongPlan: other meters', () => {
  it('3/4: three beats per bar, accent on each downbeat, one-bar count-in of 3', () => {
    const piece = buildTestPiece(quarters(6), { meter: createMeter(3, 4) });
    expect(beatTable(piece)).toEqual([
      { t: -3000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -2000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 3, bar: 0 },
      { t: 0, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 1000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 2000, ci: false, acc: false, beat: 3, bar: 1 },
      { t: 3000, ci: false, acc: true, beat: 1, bar: 2 },
      { t: 4000, ci: false, acc: false, beat: 2, bar: 2 },
      { t: 5000, ci: false, acc: false, beat: 3, bar: 2 },
    ]);
  });

  it('6/8 is compound: two dotted-quarter beats per bar', () => {
    const eighths = consecutiveNotes(
      Array.from({ length: 12 }, () => A4),
      0.125,
    );
    const piece = buildTestPiece(eighths, {
      meter: createMeter(6, 8),
      tempo: { beatLengthWhole: 0.375, bpm: 60, text: undefined }, // dotted quarter = 60
    });
    const plan = buildPlayAlongPlan(piece);
    expect(plan.countInMs).toBe(2000);
    expect(beatTable(piece)).toEqual([
      { t: -2000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: 0, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 1000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 2000, ci: false, acc: true, beat: 1, bar: 2 },
      { t: 3000, ci: false, acc: false, beat: 2, bar: 2 },
    ]);
    // A dotted-quarter beat is 1000 ms, so an eighth is a third of that.
    expect(plan.notes[0]!.beatMs).toBeCloseTo(1000, 6);
    expect(plan.notes[1]!.onsetMs).toBeCloseTo(1000 / 3, 6);
    // The second eighth of a compound beat is "1.33"; the fourth is beat 2.
    expect(plan.notes.slice(0, 6).map((n) => n.beatInBar)).toEqual([1, 1.33, 1.67, 2, 2.33, 2.67]);
  });

  it('2/2: two half-note beats per bar', () => {
    const halves = consecutiveNotes([A4, A4, A4, A4], 0.5);
    const piece = buildTestPiece(halves, {
      meter: createMeter(2, 2),
      tempo: { beatLengthWhole: 0.5, bpm: 60, text: undefined },
    });
    expect(beatTable(piece)).toEqual([
      { t: -2000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: 0, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 1000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 2000, ci: false, acc: true, beat: 1, bar: 2 },
      { t: 3000, ci: false, acc: false, beat: 2, bar: 2 },
    ]);
  });
});

describe('buildPlayAlongPlan: pickups', () => {
  // One-quarter pickup in 4/4, then a full bar: notes at 0 (pickup), 0.25..1.0.
  const pickupPiece = buildTestPiece(quarters(5), { pickupWhole: 0.25 });

  it('anchors the grid on the first full bar, so the count-in reaches back into the pickup bar', () => {
    expect(beatTable(pickupPiece)).toEqual([
      // Count-in: the 4 grid beats before the music (beat 4 of the bar before, then 1 2 3).
      { t: -4000, ci: true, acc: false, beat: 4, bar: 0 },
      { t: -3000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -2000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 3, bar: 0 },
      // The pickup note sits on beat 4 of the pickup bar: a real grid beat at position 0.
      { t: 0, ci: false, acc: false, beat: 4, bar: 0 },
      // The first full bar's downbeat is accented, at position 0.25.
      { t: 1000, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 2000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 3000, ci: false, acc: false, beat: 3, bar: 1 },
      { t: 4000, ci: false, acc: false, beat: 4, bar: 1 },
    ]);
  });

  it('numbers the pickup bar 0 and the first full bar 1, on notes as well', () => {
    const plan = buildPlayAlongPlan(pickupPiece);
    expect(plan.notes.map((n) => [n.barNumber, n.beatInBar])).toEqual([
      [0, 4],
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
  });

  it('honours a custom count-in that stops at the pickup ("1 2 3", then the pickup on 4)', () => {
    const table = beatTable(pickupPiece, { countInBeats: 3 });
    expect(table.filter((b) => b.ci)).toEqual([
      { t: -3000, ci: true, acc: true, beat: 1, bar: 0 },
      { t: -2000, ci: true, acc: false, beat: 2, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 3, bar: 0 },
    ]);
  });

  it('an eighth-note pickup (half a beat) is an off-beat: no click on the pickup, the first click is the downbeat', () => {
    const notes = [{ midi: A4, startWhole: 0, durationWhole: 0.125 }, ...quarters(4, 0.125)];
    const piece = buildTestPiece(notes, { pickupWhole: 0.125 });
    const plan = buildPlayAlongPlan(piece);
    expect(plan.countInMs).toBeCloseTo(3500, 6);
    const music = plan.beats.filter((b) => !b.countIn);
    expect(music[0]!.tMs).toBeCloseTo(500, 6);
    expect(music[0]!.accent).toBe(true);
    expect(music[0]!.barNumber).toBe(1);
    // The pickup eighth is the "and" of beat 4.
    expect(plan.notes[0]!.beatInBar).toBe(4.5);
    expect(plan.notes[0]!.barNumber).toBe(0);
    expect(plan.notes[1]!.beatInBar).toBe(1);
    expect(plan.notes[1]!.barNumber).toBe(1);
  });

  it('a piece without a pickup starts at bar 1, beat 1', () => {
    const plan = buildPlayAlongPlan(buildTestPiece(quarters(4)));
    expect(plan.notes[0]!.barNumber).toBe(1);
    expect(plan.notes[0]!.beatInBar).toBe(1);
  });
});

describe('buildPlayAlongPlan: meter changes', () => {
  it('re-anchors the grid at a meter change (4/4 -> 3/4): the new bar starts with an accent', () => {
    const piece = buildTestPiece(quarters(7), {
      meterChanges: [{ at: 1.0, meter: createMeter(3, 4) }],
    });
    const music = beatTable(piece).filter((b) => !b.ci);
    expect(music).toEqual([
      { t: 0, ci: false, acc: true, beat: 1, bar: 1 },
      { t: 1000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 2000, ci: false, acc: false, beat: 3, bar: 1 },
      { t: 3000, ci: false, acc: false, beat: 4, bar: 1 },
      { t: 4000, ci: false, acc: true, beat: 1, bar: 2 },
      { t: 5000, ci: false, acc: false, beat: 2, bar: 2 },
      { t: 6000, ci: false, acc: false, beat: 3, bar: 2 },
    ]);
    const plan = buildPlayAlongPlan(piece);
    expect(plan.notes[4]!.barNumber).toBe(2);
    expect(plan.notes[4]!.beatInBar).toBe(1);
  });

  it('keeps the tempo as note speed across a change of beat length (4/4 -> 6/8: the beat becomes 1500 ms)', () => {
    const notes = [
      ...quarters(4),
      ...consecutiveNotes(
        Array.from({ length: 6 }, () => A4),
        0.125,
        1.0,
      ),
    ];
    const piece = buildTestPiece(notes, {
      meterChanges: [{ at: 1.0, meter: createMeter(6, 8) }],
    });
    const plan = buildPlayAlongPlan(piece);
    const music = plan.beats.filter((b) => !b.countIn);
    expect(music.map((b) => Math.round(b.tMs))).toEqual([0, 1000, 2000, 3000, 4000, 5500]);
    expect(music.map((b) => b.beatInBar)).toEqual([1, 2, 3, 4, 1, 2]);
    expect(plan.notes[4]!.beatMs).toBeCloseTo(1500, 6); // first eighth of the 6/8 bar
    expect(plan.notes[0]!.beatMs).toBeCloseTo(1000, 6);
  });

  it('treats a meter change exactly at the end of a pickup as a second segment (the pickup bar keeps the opening grid)', () => {
    const piece = buildTestPiece(quarters(4), {
      pickupWhole: 0.25,
      meterChanges: [{ at: 0.25, meter: createMeter(3, 4) }],
    });
    const music = beatTable(piece).filter((b) => !b.ci);
    expect(music).toEqual([
      { t: 0, ci: false, acc: false, beat: 4, bar: 0 }, // beat 4 of the 4/4 pickup bar
      { t: 1000, ci: false, acc: true, beat: 1, bar: 1 }, // 3/4 begins
      { t: 2000, ci: false, acc: false, beat: 2, bar: 1 },
      { t: 3000, ci: false, acc: false, beat: 3, bar: 1 },
    ]);
  });

  it('ignores the meter element at position 0 (piece.meter already is the opening meter)', () => {
    // The builder always writes one; a pickup piece would break if it re-anchored the grid at 0.
    const plan = buildPlayAlongPlan(buildTestPiece(quarters(5), { pickupWhole: 0.25 }));
    expect(plan.beats.find((b) => !b.countIn && b.accent)!.tMs).toBe(1000);
  });
});

describe('buildPlayAlongPlan: tempo', () => {
  const piece = buildTestPiece(quarters(8));

  it('defaults to the piece tempo', () => {
    const plan = buildPlayAlongPlan(piece);
    expect(plan.tempoBpm).toBe(60);
    expect(plan.fileTempoBpm).toBe(60);
    expect(plan.tempoRatio).toBe(1);
  });

  it('tempoBpm halves / doubles every time', () => {
    const half = buildPlayAlongPlan(piece, { tempoBpm: 30 });
    expect(half.tempoRatio).toBe(0.5);
    expect(half.tempoBpm).toBe(30);
    expect(half.notes[1]!.onsetMs).toBe(2000);
    expect(half.notes[1]!.endMs).toBe(4000);
    expect(half.notes[1]!.beatMs).toBe(2000);
    expect(half.totalMs).toBe(16000);
    expect(half.countInMs).toBe(8000);
    expect(half.beats[0]!.tMs).toBe(-8000);

    const double = buildPlayAlongPlan(piece, { tempoBpm: 120 });
    expect(double.tempoRatio).toBe(2);
    expect(double.notes[1]!.onsetMs).toBe(500);
    expect(double.totalMs).toBe(4000);
    expect(double.countInMs).toBe(2000);
  });

  it('applies mid-piece tempo marks from their position on, scaled by the same ratio', () => {
    const marked = buildTestPiece(quarters(8), { tempoMarks: [{ at: 1.0, bpm: 120 }] });
    const plan = buildPlayAlongPlan(marked);
    expect(plan.msAtWhole(1.0)).toBe(4000);
    expect(plan.msAtWhole(2.0)).toBe(6000); // second bar twice as fast
    expect(plan.notes[4]!.onsetMs).toBe(4000);
    expect(plan.notes[5]!.onsetMs).toBe(4500);
    expect(plan.notes[4]!.beatMs).toBe(500);
    expect(plan.totalMs).toBe(6000);
    expect(plan.beats.filter((b) => !b.countIn).map((b) => b.tMs)).toEqual([
      0, 1000, 2000, 3000, 4000, 4500, 5000, 5500,
    ]);

    // Half the overall speed: both bars twice as long, the 2:1 relationship kept.
    const slow = buildPlayAlongPlan(marked, { tempoBpm: 30 });
    expect(slow.msAtWhole(1.0)).toBe(8000);
    expect(slow.msAtWhole(2.0)).toBe(12000);
  });

  it('converts a mark written in another beat unit exactly (dotted quarter = 40 is the same speed as quarter = 60)', () => {
    const marked = buildTestPiece(quarters(8), {
      tempoMarks: [{ at: 1.0, bpm: 40, beatLengthWhole: 0.375 }],
    });
    const plan = buildPlayAlongPlan(marked);
    expect(plan.msAtWhole(2.0)).toBeCloseTo(8000, 6);
  });

  it('lets a tempo mark at position 0 replace the opening tempo, and a later mark at the same position win', () => {
    const atZero = buildTestPiece(quarters(4), { tempoMarks: [{ at: 0, bpm: 120 }] });
    expect(buildPlayAlongPlan(atZero).totalMs).toBe(2000);
    const doubled = buildTestPiece(quarters(8), {
      tempoMarks: [
        { at: 1.0, bpm: 90 },
        { at: 1.0, bpm: 120 },
      ],
    });
    expect(buildPlayAlongPlan(doubled).msAtWhole(2.0)).toBe(6000);
  });

  it('ignores a tempo mark it cannot interpret instead of failing the plan', () => {
    const marked = buildTestPiece(quarters(8), { tempoMarks: [{ at: 1.0, bpm: 0 }] });
    expect(buildPlayAlongPlan(marked).totalMs).toBe(8000);
  });
});

describe('buildPlayAlongPlan: count-in length', () => {
  const piece = buildTestPiece(quarters(4));

  it('0 = no count-in: the first beat is the first music beat', () => {
    const plan = buildPlayAlongPlan(piece, { countInBeats: 0 });
    expect(plan.countInMs).toBe(0);
    expect(plan.beats.some((b) => b.countIn)).toBe(false);
    expect(plan.beats[0]!.tMs).toBe(0);
  });

  it('2 = the two nearest beats before the music (beats 3 and 4 of the bar before: neither accented)', () => {
    const table = beatTable(piece, { countInBeats: 2 });
    expect(table.filter((b) => b.ci)).toEqual([
      { t: -2000, ci: true, acc: false, beat: 3, bar: 0 },
      { t: -1000, ci: true, acc: false, beat: 4, bar: 0 },
    ]);
    expect(buildPlayAlongPlan(piece, { countInBeats: 2 }).countInMs).toBe(2000);
  });

  it('a count-in longer than a bar keeps the accent rule (6 beats: 3 4 | 1 2 3 4)', () => {
    const count = beatTable(piece, { countInBeats: 6 }).filter((b) => b.ci);
    expect(count.map((b) => b.beat)).toEqual([3, 4, 1, 2, 3, 4]);
    expect(count.map((b) => b.acc)).toEqual([false, false, true, false, false, false]);
    expect(count.map((b) => b.t)).toEqual([-6000, -5000, -4000, -3000, -2000, -1000]);
  });
});

describe('buildPlayAlongPlan: validation', () => {
  const piece = buildTestPiece(quarters(4));

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects tempoBpm = %s', (tempoBpm) => {
    expect(() => buildPlayAlongPlan(piece, { tempoBpm })).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects countInBeats = %s',
    (countInBeats) => {
      expect(() => buildPlayAlongPlan(piece, { countInBeats })).toThrow(RangeError);
    },
  );

  it('rejects a piece whose own tempo is unusable', () => {
    const broken = { ...piece, tempo: { beatLengthWhole: 0.25, bpm: 0, text: undefined } };
    expect(() => buildPlayAlongPlan(broken)).toThrow(RangeError);
  });

  it('rejects a piece whose notes and note elements disagree', () => {
    const broken = { ...piece, noteElements: piece.noteElements.slice(1) };
    expect(() => buildPlayAlongPlan(broken)).toThrow(RangeError);
  });

  it('refuses a meter so fine it would need an absurd number of clicks, instead of hanging', () => {
    const silly = buildTestPiece(quarters(4), { meter: createMeter(4, 2_000_000) });
    expect(() => buildPlayAlongPlan(silly)).toThrow(RangeError);
    expect(MAX_PLAN_BEATS).toBeGreaterThan(5000);
  });

  it('copes with an empty piece (count-in only)', () => {
    const empty = buildTestPiece([], { totalWhole: 0 });
    const plan = buildPlayAlongPlan(empty);
    expect(plan.notes).toHaveLength(0);
    expect(plan.totalMs).toBe(0);
    expect(plan.beats.every((b) => b.countIn)).toBe(true);
  });
});

describe('buildPlayAlongPlan: msAtWhole / wholeAtMs', () => {
  const marked = buildTestPiece(quarters(12), {
    tempoMarks: [
      { at: 1.0, bpm: 120 },
      { at: 2.0, bpm: 30 },
    ],
  });
  const plan = buildPlayAlongPlan(marked);

  it('is piecewise linear through the tempo changes', () => {
    expect(plan.msAtWhole(0)).toBe(0);
    expect(plan.msAtWhole(0.5)).toBe(2000);
    expect(plan.msAtWhole(1.0)).toBe(4000);
    expect(plan.msAtWhole(1.5)).toBe(5000);
    expect(plan.msAtWhole(2.0)).toBe(6000);
    expect(plan.msAtWhole(2.5)).toBe(10000); // 30 bpm: 8000 ms per whole note
    expect(plan.msAtWhole(3.0)).toBe(14000);
  });

  it('extrapolates before the start with the first tempo and after the end with the last', () => {
    expect(plan.msAtWhole(-1)).toBe(-4000);
    expect(plan.msAtWhole(-0.25)).toBe(-1000);
    expect(plan.msAtWhole(4.0)).toBe(14000 + 8000);
  });

  it('wholeAtMs inverts msAtWhole, including negative positions and across tempo changes', () => {
    for (const whole of [-1.5, -0.25, 0, 0.3, 0.999, 1, 1.7, 2, 2.2, 3, 5]) {
      expect(plan.wholeAtMs(plan.msAtWhole(whole))).toBeCloseTo(whole, 9);
    }
    for (const ms of [-6000, -1, 0, 1234, 4000, 5500, 6000, 9000, 20000]) {
      expect(plan.msAtWhole(plan.wholeAtMs(ms))).toBeCloseTo(ms, 6);
    }
  });

  it('does not throw on non-finite input', () => {
    expect(Number.isNaN(plan.msAtWhole(Number.NaN))).toBe(true);
    expect(Number.isNaN(plan.wholeAtMs(Number.NaN))).toBe(true);
  });
});

describe('buildPlayAlongPlan: notes', () => {
  it('carries pitch, frequency and a staff-spelled label', () => {
    const piece = buildTestPiece([
      {
        midi: 70,
        startWhole: 0,
        durationWhole: 0.25,
        spelling: { letter: 'B', accidental: -1, octave: 4 },
      },
      { midi: 66, startWhole: 0.25, durationWhole: 0.25 },
    ]);
    const plan = buildPlayAlongPlan(piece);
    expect(plan.notes[0]!.label).toBe('B♭4'); // B-flat, as the sheet writes it
    expect(plan.notes[1]!.label).toBe('F♯4');
    expect(plan.notes[0]!.midi).toBe(70);
    expect(plan.notes[1]!.frequencyHz).toBeCloseTo(369.99, 1);
    expect(plan.notes[1]!.index).toBe(1);
  });

  it('reports onset/end in ms, and beat positions within the bar, rounded to 2 decimals', () => {
    const piece = buildTestPiece([
      { midi: A4, startWhole: 0, durationWhole: 0.125 },
      { midi: A4, startWhole: 0.125, durationWhole: 0.125 },
      { midi: A4, startWhole: 0.25, durationWhole: 0.25 },
      { midi: A4, startWhole: 0.5, durationWhole: 1 / 12 },
      { midi: A4, startWhole: 0.5 + 1 / 12, durationWhole: 1 / 12 },
      { midi: A4, startWhole: 0.5 + 2 / 12, durationWhole: 1 / 12 },
    ]);
    const plan = buildPlayAlongPlan(piece);
    expect(plan.notes[1]!.onsetMs).toBe(500);
    expect(plan.notes[1]!.endMs).toBe(1000);
    expect(plan.notes.map((n) => n.beatInBar)).toEqual([1, 1.5, 2, 3, 3.33, 3.67]);
    expect(plan.notes.every((n) => n.barNumber === 1)).toBe(true);
  });

  it('numbers bars across the piece', () => {
    const plan = buildPlayAlongPlan(buildTestPiece(quarters(9)));
    expect(plan.notes.map((n) => n.barNumber)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3]);
    expect(plan.notes.map((n) => n.beatInBar)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1]);
  });
});
