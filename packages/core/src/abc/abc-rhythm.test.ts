import { describe, expect, it } from 'vitest';
import { parseAbc } from './abc-parser.js';
import { buildAbcPracticeSequence } from './abc-practice.js';
import type {
  AbcBarElement,
  AbcNoteElement,
  AbcRestElement,
  AbcScoreElement,
} from './abc-score.js';

/**
 * Lengths below are worked out by hand from the ABC rules in whole notes (a
 * quarter = 0.25). The parser's timeline was additionally cross-checked
 * against abcjs on thousands of random tunes; these tests pin the rules down.
 */

const HEAD = 'M:4/4\nL:1/4\nK:C';

function tuneOf(body: string, head = HEAD) {
  return parseAbc(`X:1\nT:Test\n${head}\n${body}\n`).tunes[0]!;
}

function elementsOf(body: string, head = HEAD): readonly AbcScoreElement[] {
  return tuneOf(body, head).voices[0]!.score.elements;
}

function notesOf(body: string, head = HEAD): AbcNoteElement[] {
  return elementsOf(body, head).filter((e): e is AbcNoteElement => e.type === 'note');
}

function restsOf(body: string, head = HEAD): AbcRestElement[] {
  return elementsOf(body, head).filter((e): e is AbcRestElement => e.type === 'rest');
}

function barsOf(body: string, head = HEAD): AbcBarElement[] {
  return elementsOf(body, head).filter((e): e is AbcBarElement => e.type === 'bar');
}

/** [start, duration] of each note. */
function times(body: string, head = HEAD): Array<[number, number]> {
  return notesOf(body, head).map((n) => [n.start, n.duration]);
}

function expectTimes(actual: Array<[number, number]>, expected: Array<[number, number]>): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([start, duration], i) => {
    expect(start).toBeCloseTo(expected[i]![0], 9);
    expect(duration).toBeCloseTo(expected[i]![1], 9);
  });
}

describe('note lengths', () => {
  it('multiplies the unit note length: 2, 3, /2, 3/2, /, //, 3/, /3, 3/4', () => {
    expectTimes(times('C C2 C3 C/2 C3/2 C/ C// C3/ C/3 C3/4'), [
      [0, 0.25],
      [0.25, 0.5],
      [0.75, 0.75],
      [1.5, 0.125],
      [1.625, 0.375],
      [2, 0.125],
      [2.125, 0.0625],
      [2.1875, 0.375],
      [2.5625, 0.25 / 3],
      [2.5625 + 0.25 / 3, 0.1875],
    ]);
  });

  it('treats a zero or absurd length as a normal note and says so', () => {
    const tune = tuneOf('C0 D');
    expectTimes(times('C0 D'), [
      [0, 0.25],
      [0.25, 0.25],
    ]);
    expect(tune.warnings.some((w) => w.includes('note length'))).toBe(true);
  });

  it('reads lengths on rests, chords and after a tie', () => {
    expectTimes(times('z2 [CE]3 C-C2'), [
      [0.5, 0.75],
      [1.25, 0.75],
    ]);
  });

  it('applies the unit note length: L: header, inline [L:], and an L: line in the body', () => {
    expectTimes(times('C', 'M:4/4\nL:1/8\nK:C'), [[0, 0.125]]);
    expectTimes(times('C [L:1/16] D | E', 'M:4/4\nL:1/4\nK:C'), [
      [0, 0.25],
      [0.25, 0.0625],
      [0.3125, 0.0625],
    ]);
    expectTimes(times('C\nL:1/8\nD', 'M:4/4\nL:1/4\nK:C'), [
      [0, 0.25],
      [0.25, 0.125],
    ]);
  });

  it('defaults the unit note length from the meter, as ABC does (1/16 below 3/4, else 1/8; 1/8 with no meter)', () => {
    expect(tuneOf('C', 'M:2/4\nK:C').unitNoteLength).toBe(1 / 16);
    expect(tuneOf('C', 'M:3/8\nK:C').unitNoteLength).toBe(1 / 16);
    expect(tuneOf('C', 'M:3/4\nK:C').unitNoteLength).toBe(1 / 8);
    expect(tuneOf('C', 'M:6/8\nK:C').unitNoteLength).toBe(1 / 8);
    expect(tuneOf('C', 'M:C\nK:C').unitNoteLength).toBe(1 / 8);
    expect(tuneOf('C', 'K:C').unitNoteLength).toBe(1 / 8);
    // An explicit L: wins, wherever it sits relative to M:.
    expect(tuneOf('C', 'L:1/4\nM:2/4\nK:C').unitNoteLength).toBe(1 / 4);
  });

  it('warns about an unreadable L: and keeps the default', () => {
    const tune = tuneOf('C', 'M:4/4\nL:fast\nK:C');
    expect(tune.unitNoteLength).toBe(1 / 8);
    expect(tune.warnings.some((w) => w.includes('unit note length'))).toBe(true);
  });
});

describe('rests', () => {
  it('takes time without producing a practice note (z, x, Z)', () => {
    const rests = restsOf('C z2 D x D Z');
    expect(rests.map((r) => [r.start, r.duration, r.visible])).toEqual([
      [0.25, 0.5, true],
      [1, 0.25, false],
      [1.5, 1, true],
    ]);
    expectTimes(times('C z2 D x D Z'), [
      [0, 0.25],
      [0.75, 0.25],
      [1.25, 0.25],
    ]);
  });

  it('expands Zn into n whole-bar rests with a bar line between them', () => {
    const elements = elementsOf('C3 Z3 | D');
    const rests = elements.filter((e): e is AbcRestElement => e.type === 'rest');
    expect(rests.map((r) => [r.start, r.duration])).toEqual([
      [0.75, 1],
      [1.75, 1],
      [2.75, 1],
    ]);
    // C3 + Z3 (= 3 bars) leaves the first bar line only after the rests; two synthetic bar lines separate them.
    expect(rests.map((r) => r.bar)).toEqual([0, 1, 2]);
    expectTimes(times('C3 Z3 | D'), [
      [0, 0.75],
      [3.75, 0.25],
    ]);
  });

  it('measures a bar rest in the current meter', () => {
    expect(restsOf('Z', 'M:6/8\nL:1/8\nK:C')[0]!.duration).toBeCloseTo(0.75, 9);
    expect(restsOf('Z', 'M:3/4\nL:1/4\nK:C')[0]!.duration).toBeCloseTo(0.75, 9);
    // No meter at all: a bar is taken as 4/4.
    expect(restsOf('Z', 'L:1/4\nK:C')[0]!.duration).toBe(1);
  });

  it('gives the spacer y no time', () => {
    expectTimes(times('C y D'), [
      [0, 0.25],
      [0.25, 0.25],
    ]);
    expect(restsOf('C y D')).toHaveLength(0);
  });

  it('leaves a gap before a note after leading rests', () => {
    expectTimes(times('z4 C'), [[1, 0.25]]);
  });
});

describe('ties', () => {
  it('merges tied notes into one note as long as both parts', () => {
    expectTimes(times('C2-C2 D'), [
      [0, 1],
      [1, 0.25],
    ]);
  });

  it('merges across a bar line', () => {
    expectTimes(times('C4- | C2 D'), [
      [0, 1.5],
      [1.5, 0.25],
    ]);
  });

  it('chains more than two', () => {
    expectTimes(times('C-C-C2'), [[0, 1]]);
  });

  it('keeps the bar line where it is when a tie runs across it (the bar line falls inside the tied note)', () => {
    const voice = tuneOf('C D E F- | F G A B |]').voices[0]!;
    expect(voice.score.barStartsWhole).toEqual([0, 1]);
    expect(voice.score.barCount).toBe(2);
    expect(voice.score.totalWhole).toBeCloseTo(2, 9);
    const bar = voice.score.elements.find((e): e is AbcBarElement => e.type === 'bar')!;
    expect(bar.at).toBeCloseTo(1, 9);
    const tied = voice.score.elements.find(
      (e): e is AbcNoteElement => e.type === 'note' && e.noteIndex === 3,
    )!;
    // F starts at 0.75 in bar 0 and lasts two quarters, so it crosses the bar line at 1.
    expect([tied.start, tied.duration, tied.bar]).toEqual([0.75, 0.5, 0]);
    // The note after the tie starts a quarter into bar 1.
    expect(voice.score.elements.filter((e) => e.type === 'note')[4]).toMatchObject({
      start: 1.25,
      bar: 1,
    });
  });

  it('does not make a pickup or an irregular bar out of a tie across a bar line', () => {
    const voice = tuneOf('G | c2 B A- | A2 G2 | G4 |]').voices[0]!;
    expect(voice.score.pickupWhole).toBeCloseTo(0.25, 9);
    expect(voice.score.barStartsWhole.map((n) => +n.toFixed(6))).toEqual([0, 0.25, 1.25, 2.25]);
    expect(tuneOf('C D E F- | F G A B | c d e f |').warnings).toEqual([]);
    expect(
      tuneOf('C D E F- | F2- | F G A | c d e f |').warnings.some((w) =>
        w.includes('2 bars are not 4/4 long'),
      ),
    ).toBe(true);
  });

  it('counts a bar that holds only the end of a tie as music', () => {
    const voice = tuneOf('C4- | C4 | D4 |]').voices[0]!;
    expect(voice.score.barCount).toBe(3);
    expect(voice.score.barStartsWhole).toEqual([0, 1, 2]);
  });

  it("keeps the tied note's bar as the bar it starts in", () => {
    expect(notesOf('C4- | C2 D').map((n) => n.bar)).toEqual([0, 1]);
  });
});

describe('broken rhythm', () => {
  it('dots the first note and shortens the second for > (1.5 / 0.5)', () => {
    expectTimes(times('C>D'), [
      [0, 0.375],
      [0.375, 0.125],
    ]);
  });

  it('does the reverse for <', () => {
    expectTimes(times('C<D'), [
      [0, 0.125],
      [0.125, 0.375],
    ]);
  });

  it('doubles up: >> is 1.75 / 0.25, >>> is 1.875 / 0.125, << is 0.25 / 1.75', () => {
    expectTimes(times('C>>D'), [
      [0, 0.4375],
      [0.4375, 0.0625],
    ]);
    expectTimes(times('C>>>D'), [
      [0, 0.46875],
      [0.46875, 0.03125],
    ]);
    expectTimes(times('C<<D'), [
      [0, 0.0625],
      [0.0625, 0.4375],
    ]);
  });

  it('works between notes of any length', () => {
    expectTimes(times('C2>D2'), [
      [0, 0.75],
      [0.75, 0.25],
    ]);
  });

  it('applies to rests too', () => {
    expectTimes(times('z>C'), [[0.375, 0.125]]);
    expectTimes(times('C>z D'), [
      [0, 0.375],
      [0.5, 0.25],
    ]);
  });

  it('dots only the last part of a tied note', () => {
    // F-F then > : the second F (not the whole tie) is lengthened.
    expectTimes(times('C/-C/>D', 'M:4/4\nL:1/4\nK:C'), [
      [0, 0.125 + 0.1875],
      [0.3125, 0.125],
    ]);
  });
});

describe('tuplets', () => {
  it('scales the next notes by q/p: a triplet is 2/3', () => {
    expectTimes(times('(3CDE F'), [
      [0, 1 / 6],
      [1 / 6, 1 / 6],
      [2 / 6, 1 / 6],
      [0.5, 0.25],
    ]);
  });

  it('uses the standard defaults for q', () => {
    // (2 -> 3, (4 -> 3, (5 -> 2, (6 -> 2, (7 -> 2, (8 -> 3, (9 -> 2) in simple time.
    const q = (p: number) => {
      const notes = Array.from({ length: p }, () => 'C').join('');
      return notesOf(`(${p}${notes}`)[0]!.duration * p;
    };
    expect(q(2)).toBeCloseTo(0.75, 9);
    expect(q(3)).toBeCloseTo(0.5, 9);
    expect(q(4)).toBeCloseTo(0.75, 9);
    expect(q(5)).toBeCloseTo(0.5, 9);
    expect(q(6)).toBeCloseTo(0.5, 9);
    expect(q(7)).toBeCloseTo(0.5, 9);
    expect(q(8)).toBeCloseTo(0.75, 9);
    expect(q(9)).toBeCloseTo(0.5, 9);
  });

  it('uses 3 for (5, (7 and (9 in compound time', () => {
    const head = 'M:6/8\nL:1/8\nK:C';
    const sum = (p: number) =>
      notesOf(`(${p}${'C'.repeat(p)}`, head).reduce((total, n) => total + n.duration, 0);
    expect(sum(5)).toBeCloseTo(0.375, 9);
    expect(sum(7)).toBeCloseTo(0.375, 9);
    expect(sum(3)).toBeCloseTo(0.25, 9);
  });

  it('takes explicit (p:q:r and stops after r notes', () => {
    expectTimes(times('(3:2:2CD E'), [
      [0, 1 / 6],
      [1 / 6, 1 / 6],
      [1 / 3, 0.25],
    ]);
    expectTimes(times('(5:4:5CDEFG A'), [
      [0, 0.2],
      [0.2, 0.2],
      [0.4, 0.2],
      [0.6, 0.2],
      [0.8, 0.2],
      [1, 0.25],
    ]);
  });

  it('counts rests in the group', () => {
    expectTimes(times('(3zCD E'), [
      [1 / 6, 1 / 6],
      [2 / 6, 1 / 6],
      [0.5, 0.25],
    ]);
  });

  it('records the group on each member and the written (unscaled) length', () => {
    const [a, b, c, d] = notesOf('(3CDE F');
    expect(a!.tuplet).toMatchObject({ actual: 3, normal: 2, size: 3, index: 0 });
    expect(b!.tuplet).toMatchObject({ index: 1 });
    expect(c!.tuplet).toMatchObject({ index: 2 });
    expect(a!.tuplet!.id).toBe(b!.tuplet!.id);
    expect(d!.tuplet).toBeUndefined();
    expect(a!.notated).toBeCloseTo(0.25, 9);
    expect(a!.duration).toBeCloseTo(1 / 6, 9);
  });

  it('gives separate groups separate ids', () => {
    const notes = notesOf('(3CDE (3FGA');
    expect(notes[0]!.tuplet!.id).not.toBe(notes[3]!.tuplet!.id);
  });

  it('does not mistake a slur for a tuplet', () => {
    expectTimes(times('(CD)'), [
      [0, 0.25],
      [0.25, 0.25],
    ]);
  });
});

describe('chords and grace notes', () => {
  it('lasts as long as the first note of the chord times the length after the bracket', () => {
    expectTimes(times('[CEG]2 [C2EG] [CE2G] [CEG]/2'), [
      [0, 0.5],
      [0.5, 0.5],
      [1, 0.25],
      [1.25, 0.125],
    ]);
    expectTimes(times('[C2E2G2]3'), [[0, 1.5]]);
  });

  it('gives grace notes no time', () => {
    expectTimes(times('{g}C {ag}D'), [
      [0, 0.25],
      [0.25, 0.25],
    ]);
  });
});

describe('bars', () => {
  it('numbers bars from 0 and tells each note its bar', () => {
    const voice = tuneOf('C D E F | G A B c | d').voices[0]!;
    expect(notesOf('C D E F | G A B c | d').map((n) => n.bar)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2]);
    expect(voice.score.barCount).toBe(3);
    expect(voice.score.barStartsWhole).toEqual([0, 1, 2]);
    expect(voice.score.totalWhole).toBeCloseTo(2.25, 9);
  });

  it('puts the bar line between the last note of one bar and the first of the next', () => {
    const bars = barsOf('C D E F | G A B c |]');
    expect(bars.map((b) => [b.at, b.after, b.style])).toEqual([
      [1, 0, 'single'],
      [2, 1, 'final'],
    ]);
  });

  it('does not create empty bars from a leading or doubled bar line', () => {
    const voice = tuneOf('|: C D E F | | G A B c :|').voices[0]!;
    expect(voice.score.barCount).toBe(2);
    const bars = voice.score.elements.filter((e): e is AbcBarElement => e.type === 'bar');
    expect(bars.map((b) => [b.style, b.after])).toEqual([
      ['repeat-start', -1],
      ['single', 0],
      ['repeat-end', 1],
    ]);
  });

  it('classifies bar line styles', () => {
    const style = (token: string) => barsOf(`C ${token} D`)[0]!.style;
    expect(style('|')).toBe('single');
    expect(style('||')).toBe('double');
    expect(style('[|')).toBe('double');
    expect(style('|]')).toBe('final');
    expect(style('|:')).toBe('repeat-start');
    expect(style(':|')).toBe('repeat-end');
    expect(style('::')).toBe('repeat-both');
    expect(style(':|:')).toBe('repeat-both');
    expect(style(':||:')).toBe('repeat-both');
  });

  it('merges back-to-back bar lines into one (end + start repeat become both)', () => {
    const bars = barsOf('C D E F :| |: G');
    expect(bars).toHaveLength(1);
    expect(bars[0]!.style).toBe('repeat-both');
  });

  it('skips first and second endings without losing the bar line', () => {
    const voice = tuneOf('C D E F |1 G A B c :|2 G A B d |]').voices[0]!;
    expect(voice.score.barCount).toBe(3);
    expect(voice.notes).toHaveLength(12);
  });

  it('counts a final bar with no closing bar line', () => {
    expect(tuneOf('C D E F | G').voices[0]!.score.barCount).toBe(2);
    expect(tuneOf('C D E F |').voices[0]!.score.barCount).toBe(1);
  });

  it('detects a pickup: a first bar shorter than the meter', () => {
    const voice = tuneOf('G | c2 B A | G4 |]').voices[0]!;
    expect(voice.score.pickupWhole).toBeCloseTo(0.25, 9);
    expect(voice.score.barStartsWhole[1]).toBeCloseTo(0.25, 9);
    // A full first bar is no pickup, nor is a one-bar tune.
    expect(tuneOf('C D E F | G').voices[0]!.score.pickupWhole).toBe(0);
    expect(tuneOf('G').voices[0]!.score.pickupWhole).toBe(0);
  });

  it('measures a pickup against the meter in force, not 4/4', () => {
    const voice = tuneOf('D | G2 A | B', 'M:3/4\nL:1/4\nK:G').voices[0]!;
    expect(voice.score.pickupWhole).toBeCloseTo(0.25, 9);
  });

  it('warns about bars that do not add up to the meter (but not a pickup or the last bar)', () => {
    const odd = tuneOf('C D E F | G A B | c d e f | g');
    expect(odd.warnings.some((w) => w.includes('Bar 2') && w.includes('3 beats'))).toBe(true);
    const fine = tuneOf('G | c2 B A | c2 B A | G2 |]');
    expect(fine.warnings).toEqual([]);
    // No meter, nothing to check against.
    const free = tuneOf('C D E | F G A B | c', 'L:1/4\nK:C');
    expect(free.warnings).toEqual([]);
  });

  it('does not warn about short bars next to repeat marks (sections end short)', () => {
    const tune = tuneOf('C D E F | G A B c :|: d e f | g a b c |]');
    expect(tune.warnings).toEqual([]);
  });
});

describe('beaming', () => {
  it('flags a note as beamed to the previous one when there is no space between them', () => {
    const notes = notesOf('C/D/E/F/ G/A/ B/c/', 'M:4/4\nL:1/4\nK:C');
    expect(notes.map((n) => n.beamedToPrevious)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('does not beam across a space, a bar line or a line break', () => {
    expect(notesOf('C/ D/|E/F/').map((n) => n.beamedToPrevious)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(notesOf('C/D/\nE/F/').map((n) => n.beamedToPrevious)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('is not broken by decorations, chord symbols or a slur between notes', () => {
    expect(notesOf('C/!trill!D/ E/"G"F/').map((n) => n.beamedToPrevious)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('beams rests with their neighbours too (the layout decides what it draws)', () => {
    expect(restsOf('C/z/D/')[0]!.beamedToPrevious).toBe(true);
  });
});

describe('meter (M:)', () => {
  const meterOf = (m: string) => tuneOf('C', `M:${m}\nL:1/4\nK:C`).meter!;

  it('reads simple and compound meters and works out the metronome beat', () => {
    expect(meterOf('4/4')).toMatchObject({
      barLengthWhole: 1,
      beatLengthWhole: 0.25,
      beatsPerBar: 4,
      display: '4/4',
    });
    expect(meterOf('3/4')).toMatchObject({
      barLengthWhole: 0.75,
      beatLengthWhole: 0.25,
      beatsPerBar: 3,
    });
    expect(meterOf('2/2')).toMatchObject({
      barLengthWhole: 1,
      beatLengthWhole: 0.5,
      beatsPerBar: 2,
    });
    expect(meterOf('6/8')).toMatchObject({
      barLengthWhole: 0.75,
      beatLengthWhole: 0.375,
      beatsPerBar: 2,
    });
    expect(meterOf('9/8')).toMatchObject({ beatLengthWhole: 0.375, beatsPerBar: 3 });
    expect(meterOf('12/8')).toMatchObject({ beatLengthWhole: 0.375, beatsPerBar: 4 });
    // 3/8 is three eighth-note beats, not one dotted-quarter.
    expect(meterOf('3/8')).toMatchObject({ beatLengthWhole: 0.125, beatsPerBar: 3 });
    expect(meterOf('5/8')).toMatchObject({ beatLengthWhole: 0.125, beatsPerBar: 5 });
  });

  it('reads C, C| and summed numerators', () => {
    expect(meterOf('C')).toMatchObject({
      numerator: 4,
      denominator: 4,
      symbol: 'common',
      display: 'C',
    });
    expect(meterOf('C|')).toMatchObject({
      numerator: 2,
      denominator: 2,
      symbol: 'cut',
      display: 'C|',
    });
    expect(meterOf('(2+3+2)/8')).toMatchObject({ numerator: 7, denominator: 8, display: '7/8' });
    expect(meterOf('2+3/8')).toMatchObject({ numerator: 5, denominator: 8 });
  });

  it('has no meter for none, a missing M:, or something unreadable (with a warning)', () => {
    expect(tuneOf('C', 'M:none\nK:C').meter).toBeUndefined();
    expect(tuneOf('C', 'K:C').meter).toBeUndefined();
    const bad = tuneOf('C', 'M:foo\nK:C');
    expect(bad.meter).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes('meter'))).toBe(true);
  });

  it('emits the header meter at position 0 and an inline change where it happens', () => {
    const elements = elementsOf('C D E F | [M:3/4] G A B', 'M:4/4\nL:1/4\nK:C');
    const meters = elements.filter((e) => e.type === 'meter');
    expect(meters.map((e) => [e.type === 'meter' && e.meter.display, e.at])).toEqual([
      ['4/4', 0],
      ['3/4', 1],
    ]);
  });
});

describe('tempo (Q:)', () => {
  const tempoOf = (q: string, meter = 'M:4/4') => tuneOf('C', `${meter}\nL:1/8\n${q}\nK:C`).tempo;

  it('reads the common forms', () => {
    expect(tempoOf('Q:1/4=120')).toEqual({ beatLengthWhole: 0.25, bpm: 120, text: undefined });
    expect(tempoOf('Q:1/4 = 100')).toMatchObject({ beatLengthWhole: 0.25, bpm: 100 });
    expect(tempoOf('Q:3/8=50')).toMatchObject({ beatLengthWhole: 0.375, bpm: 50 });
    expect(tempoOf('Q:1/2=60')).toMatchObject({ beatLengthWhole: 0.5, bpm: 60 });
    expect(tempoOf('Q:C=120')).toMatchObject({ beatLengthWhole: 0.25, bpm: 120 });
    expect(tempoOf('Q:1/8=180')).toMatchObject({ beatLengthWhole: 0.125, bpm: 180 });
  });

  it('keeps a text label, before or after the number', () => {
    expect(tempoOf('Q:"Allegro" 1/4=120')).toMatchObject({ bpm: 120, text: 'Allegro' });
    expect(tempoOf('Q:1/4=120 "Allegro"')).toMatchObject({ bpm: 120, text: 'Allegro' });
    expect(tempoOf('Q:ca. 1/4=120')).toMatchObject({ bpm: 120 });
  });

  it('adds several beat lengths together', () => {
    expect(tempoOf('Q:1/4 3/8 1/4 3/8=40')).toMatchObject({ beatLengthWhole: 1.25, bpm: 40 });
  });

  it("counts a bare number in the meter's 1/denominator note (as abcjs does)", () => {
    expect(tempoOf('Q:120', 'M:4/4')).toMatchObject({ beatLengthWhole: 0.25, bpm: 120 });
    expect(tempoOf('Q:90', 'M:6/8')).toMatchObject({ beatLengthWhole: 0.125, bpm: 90 });
  });

  it('is undefined for text-only or missing, and warns about nonsense', () => {
    expect(tempoOf('Q:"Andante"')).toBeUndefined();
    expect(tuneOf('C', 'K:C').tempo).toBeUndefined();
    const bad = tuneOf('C', 'Q:fast=slow\nK:C');
    expect(bad.tempo).toBeUndefined();
    expect(bad.warnings.some((w) => w.includes('tempo'))).toBe(true);
    expect(tempoOf('Q:1/4=0')).toBeUndefined();
    expect(tempoOf('Q:1/4=99999')).toBeUndefined();
  });

  it('does not depend on whether Q: comes before or after M:', () => {
    const tune = tuneOf('C', 'Q:100\nM:6/8\nK:C');
    expect(tune.tempo).toMatchObject({ beatLengthWhole: 0.125, bpm: 100 });
  });

  it('emits the header tempo at 0 and an inline change where it happens', () => {
    const elements = elementsOf('C D E F | [Q:1/4=90] G', 'M:4/4\nL:1/4\nQ:1/4=60\nK:C');
    const tempos = elements.filter((e) => e.type === 'tempo');
    expect(tempos.map((e) => [e.type === 'tempo' && e.mark.bpm, e.at])).toEqual([
      [60, 0],
      [90, 1],
    ]);
  });
});

describe('key elements', () => {
  it('starts every voice with the header key, meter and tempo at position 0', () => {
    const elements = elementsOf('C', 'M:3/4\nL:1/4\nQ:1/4=80\nK:G');
    expect(elements.slice(0, 3).map((e) => e.type)).toEqual(['key', 'meter', 'tempo']);
    const key = elements[0]!;
    expect(key.type === 'key' && key.fifths).toBe(1);
    expect(key.type === 'key' && key.offsets.F).toBe(1);
  });

  it('records the position on the circle of fifths, and none for an explicit key', () => {
    const fifthsOf = (k: string) => {
      const key = elementsOf('C', `L:1/4\nK:${k}`)[0]!;
      return key.type === 'key' ? key.fifths : 'not a key';
    };
    expect(fifthsOf('C')).toBe(0);
    expect(fifthsOf('F')).toBe(-1);
    expect(fifthsOf('Bb')).toBe(-2);
    expect(fifthsOf('A')).toBe(3);
    expect(fifthsOf('Am')).toBe(0);
    expect(fifthsOf('Edor')).toBe(2);
    expect(fifthsOf('D exp _b')).toBeUndefined();
    expect(fifthsOf('D _b')).toBeUndefined();
  });

  it('adds a key element where a mid-tune key change happens', () => {
    const elements = elementsOf('C D E F | [K:G] F G', 'M:4/4\nL:1/4\nK:C');
    const keys = elements.filter((e) => e.type === 'key');
    expect(keys.map((e) => [e.type === 'key' && e.fifths, e.at])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe('buildAbcPracticeSequence: the piece', () => {
  function pieceOf(body: string, head = HEAD, options = {}) {
    const result = buildAbcPracticeSequence(tuneOf(body, head), options);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    return result.piece;
  }

  it('pairs each practice note with its score element and carries the totals', () => {
    const piece = pieceOf('G | c2 B A | G4 |]');
    expect(piece.notes).toHaveLength(5);
    expect(piece.noteElements.map((e) => e.noteIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(piece.noteElements[1]!.start).toBeCloseTo(0.25, 9);
    expect(piece.pickupWhole).toBeCloseTo(0.25, 9);
    expect(piece.barCount).toBe(3);
    expect(piece.totalWhole).toBeCloseTo(2.25, 9);
  });

  it('uses the file meter and tempo when it has them', () => {
    const piece = pieceOf('C', 'M:3/4\nL:1/4\nQ:1/4=72\nK:C');
    expect(piece.meter.display).toBe('3/4');
    expect(piece.meterAssumed).toBe(false);
    expect(piece.tempo).toMatchObject({ bpm: 72, beatLengthWhole: 0.25 });
    expect(piece.tempoSource).toBe('file');
  });

  it("assumes 4/4 and a default tempo in the meter's own beat when the file has neither", () => {
    const plain = pieceOf('C', 'L:1/4\nK:C');
    expect(plain.meter.display).toBe('4/4');
    expect(plain.meterAssumed).toBe(true);
    expect(plain.tempoSource).toBe('default');
    expect(plain.tempo).toMatchObject({ beatLengthWhole: 0.25, bpm: 80 });
    const compound = pieceOf('C', 'M:6/8\nL:1/8\nK:C');
    expect(compound.tempo.beatLengthWhole).toBeCloseTo(0.375, 9);
    expect(compound.tempo.bpm).toBe(53);
  });

  it('keeps the key signature through a whole-octave transposition', () => {
    const piece = pieceOf('F', 'L:1/4\nK:G', { transposeSemitones: 12 });
    expect(piece.keyAtStart.F).toBe(1);
    const key = piece.elements.find((e) => e.type === 'key');
    expect(key?.type === 'key' && key.fifths).toBe(1);
  });

  it('drops the key signature for any other transposition (every note then carries its own sign)', () => {
    const piece = pieceOf('F', 'L:1/4\nK:G', { transposeSemitones: 1 });
    expect(piece.keyAtStart.F).toBe(0);
    const key = piece.elements.find((e) => e.type === 'key');
    expect(key?.type === 'key' && key.fifths).toBe(0);
  });

  it('reports the range in the sheet spelling (B-flat, not A-sharp)', () => {
    const result = buildAbcPracticeSequence(tuneOf('B,, D F', 'L:1/4\nK:F'), {
      transposeSemitones: 12,
    });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.lowestLabel).toBe('B♭3');
    expect(result.highestLabel).toBe('F5');
  });
});
