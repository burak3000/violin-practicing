import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import type { AbcPiece, AbcScoreElement } from '../abc/abc-score.js';
import {
  barIndexAtWhole,
  exactNoteValue,
  layoutScore,
  primitiveBounds,
  sizeScore,
  spaceForDuration,
  splitIntoNoteValues,
  type ScoreLayout,
  type ScoreLayoutOptions,
  type ScorePart,
  type ScorePrimitive,
} from './score-layout.js';
import {
  SMUFL_ANCHORS,
  SMUFL_ENGRAVING,
  STAFF_GLYPHS,
  type StaffGlyphName,
} from './staff-glyphs.js';
import { buildPiece, type BuildPieceOptions } from './test-support/piece-builder.js';

// --- helpers ------------------------------------------------------------------------------------

type Line = Extract<ScorePrimitive, { kind: 'line' }>;
type Glyph = Extract<ScorePrimitive, { kind: 'glyph' }>;
type Polygon = Extract<ScorePrimitive, { kind: 'polygon' }>;
type Path = Extract<ScorePrimitive, { kind: 'path' }>;
type Circle = Extract<ScorePrimitive, { kind: 'circle' }>;

const lines = (l: ScoreLayout, part: ScorePart): Line[] =>
  l.primitives.filter((p): p is Line => p.kind === 'line' && p.part === part);
const glyphs = (l: ScoreLayout, part: ScorePart): Glyph[] =>
  l.primitives.filter((p): p is Glyph => p.kind === 'glyph' && p.part === part);
const polygons = (l: ScoreLayout, part: ScorePart): Polygon[] =>
  l.primitives.filter((p): p is Polygon => p.kind === 'polygon' && p.part === part);
const paths = (l: ScoreLayout, part: ScorePart): Path[] =>
  l.primitives.filter((p): p is Path => p.kind === 'path' && p.part === part);
const circles = (l: ScoreLayout, part: ScorePart): Circle[] =>
  l.primitives.filter((p): p is Circle => p.kind === 'circle' && p.part === part);

function build(spec: string, options?: BuildPieceOptions): AbcPiece {
  return buildPiece(spec, options);
}

function lay(
  spec: string,
  pieceOptions?: BuildPieceOptions,
  layoutOptions: Partial<ScoreLayoutOptions> = {},
): ScoreLayout {
  return layoutScore(build(spec, pieceOptions), {
    firstBar: 0,
    widthSpaces: 300,
    justify: false,
    ...layoutOptions,
  });
}

function expectInsideViewBox(layout: ScoreLayout): void {
  const [vx, vy, vw, vh] = layout.viewBox;
  for (const p of layout.primitives) {
    const [x1, y1, x2, y2] = primitiveBounds(p);
    expect(Number.isFinite(x1 + y1 + x2 + y2)).toBe(true);
    expect(x1).toBeGreaterThanOrEqual(vx - 1e-9);
    expect(y1).toBeGreaterThanOrEqual(vy - 1e-9);
    expect(x2).toBeLessThanOrEqual(vx + vw + 1e-9);
    expect(y2).toBeLessThanOrEqual(vy + vh + 1e-9);
  }
}

const HEAD_W = STAFF_GLYPHS.noteheadBlack.width;
const STEM_W = SMUFL_ENGRAVING.stemThickness;

/** y (staff spaces) of a staff position, as the layout computes it. */
const yOf = (position: number) => (8 - position) / 2;

// --- note values ----------------------------------------------------------------------------------

describe('exactNoteValue / splitIntoNoteValues', () => {
  it('recognises every plain and dotted value', () => {
    expect(exactNoteValue(1)).toMatchObject({ base: 1, dots: 0, flags: 0 });
    expect(exactNoteValue(1 / 4)).toMatchObject({ base: 1 / 4, dots: 0, flags: 0 });
    expect(exactNoteValue(1 / 8)).toMatchObject({ base: 1 / 8, dots: 0, flags: 1 });
    expect(exactNoteValue(1 / 16)).toMatchObject({ flags: 2 });
    expect(exactNoteValue(1 / 32)).toMatchObject({ flags: 3 });
    expect(exactNoteValue(3 / 8)).toMatchObject({ base: 1 / 4, dots: 1 });
    expect(exactNoteValue(3 / 16)).toMatchObject({ base: 1 / 8, dots: 1 });
    expect(exactNoteValue(7 / 8)).toMatchObject({ base: 1 / 2, dots: 2 });
    expect(exactNoteValue(7 / 4)).toMatchObject({ base: 1, dots: 2 });
  });

  it('has no single value for 5/8, 5/16 or a triplet length', () => {
    expect(exactNoteValue(5 / 8)).toBeUndefined();
    expect(exactNoteValue(5 / 16)).toBeUndefined();
    expect(exactNoteValue(1 / 12)).toBeUndefined();
  });

  it('cuts an unrepresentable length into the fewest values, longest first', () => {
    expect(splitIntoNoteValues(5 / 8).map((v) => v.whole)).toEqual([1 / 2, 1 / 8]);
    expect(splitIntoNoteValues(5 / 16).map((v) => v.whole)).toEqual([1 / 4, 1 / 16]);
    expect(splitIntoNoteValues(9 / 16).map((v) => v.whole)).toEqual([1 / 2, 1 / 16]);
    expect(splitIntoNoteValues(5 / 4).map((v) => v.whole)).toEqual([1, 1 / 4]);
  });

  it('returns a single dotted value where one exists', () => {
    expect(splitIntoNoteValues(3 / 4)).toHaveLength(1);
    expect(splitIntoNoteValues(7 / 8)).toHaveLength(1);
  });

  it('keeps the total (to within a 64th) for any multiple of a 32nd', () => {
    for (let n = 1; n <= 160; n += 1) {
      const total = n / 32;
      const sum = splitIntoNoteValues(total).reduce((s, v) => s + v.whole, 0);
      expect(Math.abs(sum - total)).toBeLessThan(1 / 64);
    }
  });

  it('draws anything shorter than a 32nd, and zero, as one 32nd', () => {
    for (const length of [0, 1 / 256, 1 / 64 - 1e-4, -3, Number.NaN]) {
      const values = splitIntoNoteValues(length);
      expect(values).toHaveLength(1);
      expect(values[0]).toMatchObject({ base: 1 / 32, dots: 0 });
    }
  });

  it('cuts 16 whole notes into a few long values and survives absurd lengths', () => {
    const sixteen = splitIntoNoteValues(16);
    expect(sixteen.reduce((s, v) => s + v.whole, 0)).toBeCloseTo(16, 9);
    expect(sixteen.length).toBeLessThanOrEqual(10); // longest first: double-dotted wholes
    expect(splitIntoNoteValues(1e12).length).toBeLessThanOrEqual(64);
    expect(splitIntoNoteValues(Number.POSITIVE_INFINITY)).toHaveLength(1);
  });
});

describe('spaceForDuration', () => {
  it('gives a 16th about 2.2 staff spaces, a quarter about 5 and a whole about 8', () => {
    expect(spaceForDuration(1 / 16)).toBeCloseTo(2.2, 1);
    expect(spaceForDuration(1 / 4)).toBeCloseTo(5, 1);
    expect(spaceForDuration(1)).toBeGreaterThan(7.5);
    expect(spaceForDuration(1)).toBeLessThan(8.5);
  });

  it('grows with duration and never collapses or explodes', () => {
    let previous = 0;
    for (const d of [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 16, 1000]) {
      const s = spaceForDuration(d);
      expect(s).toBeGreaterThanOrEqual(previous);
      expect(s).toBeGreaterThan(1);
      expect(s).toBeLessThan(10);
      previous = s;
    }
    expect(spaceForDuration(0)).toBeGreaterThan(1);
    expect(spaceForDuration(Number.NaN)).toBeGreaterThan(1);
  });
});

// --- the staff itself -------------------------------------------------------------------------------

describe('layoutScore: staff, clef and view box', () => {
  const layout = lay('C5:1/4 D5:1/4 E5:1/4 F5:1/4 |');

  it('draws five staff lines across the whole width at y = 0..4', () => {
    const staff = lines(layout, 'staff-line');
    expect(staff.map((l) => l.y1)).toEqual([0, 1, 2, 3, 4]);
    for (const l of staff) {
      expect(l.x1).toBe(0);
      expect(l.x2).toBe(layout.viewBox[2]);
      expect(l.y1).toBe(l.y2);
      expect(l.width).toBe(SMUFL_ENGRAVING.staffLineThickness);
    }
  });

  it('draws the G clef on the G line (y = 3)', () => {
    expect(glyphs(layout, 'clef')).toEqual([expect.objectContaining({ glyph: 'gClef', y: 3 })]);
  });

  it('covers the open G (two ledger lines below) up to G6 (four above) whatever the notes', () => {
    const [, minY, , height] = layout.viewBox;
    expect(minY).toBeLessThanOrEqual(yOf(16) - 0.5); // G6 head top
    expect(minY + height).toBeGreaterThanOrEqual(yOf(-5) + 0.5); // G3 head bottom
  });

  it('keeps one height for notes inside that range, so the staff does not jump as bars change', () => {
    const low = lay('G3:1/4 A3:1/4 G3:1/4 A3:1/4 |');
    const high = lay('E6:1/4 F6:1/4 G6:1/4 E6:1/4 |');
    expect(low.viewBox[1]).toBe(layout.viewBox[1]);
    expect(low.viewBox[3]).toBe(layout.viewBox[3]);
    expect(high.viewBox[1]).toBe(layout.viewBox[1]);
    expect(high.viewBox[3]).toBe(layout.viewBox[3]);
  });

  it('grows only when a note goes beyond that range', () => {
    const beyond = lay('C7:1/4 |');
    expect(beyond.viewBox[1]).toBeLessThan(layout.viewBox[1]);
    expectInsideViewBox(beyond);
    const below = lay('C3:1/4 |');
    expect(below.viewBox[1] + below.viewBox[3]).toBeGreaterThan(
      layout.viewBox[1] + layout.viewBox[3],
    );
    expectInsideViewBox(below);
  });
});

describe('layoutScore: note placement', () => {
  it('puts each head at its staff position (E4 on the bottom line, F5 on the top, G3 below)', () => {
    const l = lay('E4:1/4 F5:1/4 G3:1/4 D4:1/4 |');
    expect(l.notes.map((n) => n.y)).toEqual([4, 0, 6.5, 4.5]);
    const heads = glyphs(l, 'head');
    expect(heads.map((h) => h.y)).toEqual([4, 0, 6.5, 4.5]);
    expect(heads.every((h) => h.glyph === 'noteheadBlack')).toBe(true);
  });

  it('reports the left edge and center of each notehead, left to right', () => {
    const l = lay('E4:1/4 F4:1/4 G4:1/4 |');
    const heads = glyphs(l, 'head');
    l.notes.forEach((n, i) => {
      expect(n.noteIndex).toBe(i);
      expect(n.x).toBe(heads[i]!.x);
      expect(n.xCenter).toBeCloseTo(heads[i]!.x + HEAD_W / 2, 9);
    });
    expect(l.notes[0]!.x).toBeLessThan(l.notes[1]!.x);
    expect(l.notes[1]!.x).toBeLessThan(l.notes[2]!.x);
  });

  it('starts the first note clear of the clef', () => {
    const l = lay('E4:1/4 |', { meter: '4/4' }, { showTimeSignature: false });
    expect(l.notes[0]!.x).toBeGreaterThan(0.3 + STAFF_GLYPHS.gClef.width);
  });

  it('uses the whole, half and quarter heads', () => {
    const l = lay('G4:1/1 | G4:1/2 G4:1/2 | G4:1/4 G4:1/4 G4:1/4 G4:1/4 |');
    expect(glyphs(l, 'head').map((h) => h.glyph)).toEqual([
      'noteheadWhole',
      'noteheadHalf',
      'noteheadHalf',
      'noteheadBlack',
      'noteheadBlack',
      'noteheadBlack',
      'noteheadBlack',
    ]);
  });

  it('spaces notes by duration: longer notes are given more room', () => {
    const l = lay('G4:1/8 G4:1/8 G4:1/4 G4:1/4 G4:1/2 G4:1/4 G4:1/4 |', undefined, {
      showTimeSignature: false,
    });
    // The space after a note follows that note's own length.
    const gaps = l.notes.slice(1).map((n, i) => n.x - l.notes[i]!.x);
    expect(gaps[2]).toBeGreaterThan(gaps[0]!); // after a quarter > after an eighth
    expect(gaps[4]).toBeGreaterThan(gaps[2]!); // after a half > after a quarter
  });

  it('lays a bar of four quarters out in about 20-25 spaces and a bar of eight 8ths in about 30', () => {
    const quarters = lay('G4:1/4 G4:1/4 G4:1/4 G4:1/4 | G4:1/4 G4:1/4 G4:1/4 G4:1/4 |');
    const [first, second] = quarters.barLines;
    const barWidth = second!.x - first!.x;
    expect(barWidth).toBeGreaterThan(19);
    expect(barWidth).toBeLessThan(26);
    const eighths = lay(
      '^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 | ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 ^G4:1/8 |',
    );
    const eighthsWidth = eighths.barLines[1]!.x - eighths.barLines[0]!.x;
    expect(eighthsWidth).toBeGreaterThan(26);
    expect(eighthsWidth).toBeLessThan(34);
  });
});

describe('layoutScore: ledger lines', () => {
  const ledgerYs = (spec: string) =>
    lines(lay(spec), 'ledger-line')
      .map((l) => l.y1)
      .sort((a, b) => a - b);

  it('needs none on or inside the staff, or in the spaces just outside it', () => {
    for (const note of ['E4', 'F5', 'C5', 'D4', 'G5']) {
      expect(ledgerYs(`${note}:1/4 |`)).toEqual([]);
    }
  });

  it('draws one for middle C and for A5, two for A3 and for C6', () => {
    expect(ledgerYs('C4:1/4 |')).toEqual([5]);
    expect(ledgerYs('A5:1/4 |')).toEqual([-1]);
    expect(ledgerYs('A3:1/4 |')).toEqual([5, 6]);
    expect(ledgerYs('C6:1/4 |')).toEqual([-2, -1]);
  });

  it('draws the open G with two lines and G6 with four', () => {
    expect(ledgerYs('G3:1/4 |')).toEqual([5, 6]);
    expect(ledgerYs('G6:1/4 |')).toEqual([-4, -3, -2, -1]);
  });

  it('extends each beyond both sides of the head and tags it with its note', () => {
    const l = lay('C4:1/4 |');
    const [ledger] = lines(l, 'ledger-line');
    const head = glyphs(l, 'head')[0]!;
    expect(ledger!.x1).toBeCloseTo(head.x - SMUFL_ENGRAVING.legerLineExtension, 9);
    expect(ledger!.x2).toBeCloseTo(head.x + HEAD_W + SMUFL_ENGRAVING.legerLineExtension, 9);
    expect(ledger!.width).toBe(SMUFL_ENGRAVING.legerLineThickness);
    expect(ledger!.noteIndex).toBe(0);
  });

  it('draws a ledger line for a whole note too, with the wider head', () => {
    const l = lay('C4:1/1 |');
    const [ledger] = lines(l, 'ledger-line');
    expect(ledger!.x2 - ledger!.x1).toBeCloseTo(
      STAFF_GLYPHS.noteheadWhole.width + 2 * SMUFL_ENGRAVING.legerLineExtension,
      9,
    );
  });
});

// --- dots, stems and flags ---------------------------------------------------------------------------

describe('layoutScore: augmentation dots', () => {
  it('draws one dot for a dotted note, two for a double-dotted one, none otherwise', () => {
    expect(glyphs(lay('G4:3/8 |'), 'dot')).toHaveLength(1);
    expect(glyphs(lay('G4:7/8 |'), 'dot')).toHaveLength(2);
    expect(glyphs(lay('G4:1/4 |'), 'dot')).toHaveLength(0);
  });

  it('puts the dot in the space above when the head sits on a line, at the head height in a space', () => {
    const onLine = lay('G4:3/8 |'); // G4 is the second line, y = 3
    expect(glyphs(onLine, 'dot')[0]!.y).toBeCloseTo(2.5, 9);
    const inSpace = lay('A4:3/8 |'); // A4 is the second space, y = 2.5
    expect(glyphs(inSpace, 'dot')[0]!.y).toBeCloseTo(2.5, 9);
    const high = lay('B4:3/8 |'); // middle line, y = 2
    expect(glyphs(high, 'dot')[0]!.y).toBeCloseTo(1.5, 9);
  });

  it('puts the dot to the right of the head and tags it with the note', () => {
    const l = lay('G4:3/8 |');
    const dot = glyphs(l, 'dot')[0]!;
    expect(dot.glyph).toBe('augmentationDot');
    expect(dot.x).toBeGreaterThan(l.notes[0]!.x + HEAD_W);
    expect(dot.noteIndex).toBe(0);
  });

  it('moves the dot clear of an up-stem flag, which curls down beside the head', () => {
    const gapAfterHead = (spec: string) => {
      const l = lay(spec, undefined, { showTimeSignature: false });
      return glyphs(l, 'dot')[0]!.x - (l.notes[0]!.x + HEAD_W);
    };
    const flaggedUp = gapAfterHead('G4:3/16 |'); // dotted eighth, stem up, flag
    const flaggedDown = gapAfterHead('D5:3/16 |'); // flag on the other side of the head
    const plain = gapAfterHead('G4:3/8 |'); // dotted quarter, no flag
    const beamed = gapAfterHead('^G4:3/16 ^A4:1/16 |');
    expect(flaggedUp).toBeGreaterThan(plain + 0.3);
    expect(flaggedDown).toBeCloseTo(plain, 9);
    expect(beamed).toBeCloseTo(plain, 9);
  });

  it('spaces two dots apart, left to right', () => {
    const [a, b] = glyphs(lay('G4:7/8 |'), 'dot');
    expect(b!.x).toBeGreaterThan(a!.x + 0.3);
  });
});

describe('layoutScore: stems', () => {
  it('draws the stem up from the right of the head for notes below the middle line, from the font anchor', () => {
    const l = lay('E4:1/4 |');
    const head = glyphs(l, 'head')[0]!;
    const [stem] = lines(l, 'stem');
    expect(stem!.x1).toBeCloseTo(head.x + SMUFL_ANCHORS.noteheadBlack.stemUpSE[0] - STEM_W / 2, 9);
    expect(stem!.x1).toBe(stem!.x2);
    expect(stem!.y1).toBeCloseTo(head.y + SMUFL_ANCHORS.noteheadBlack.stemUpSE[1], 9);
    expect(stem!.y2).toBeLessThan(stem!.y1);
    expect(stem!.width).toBe(STEM_W);
    expect(l.notes[0]!.stemUp).toBe(true);
  });

  it('draws the stem down from the left of the head from the middle line up', () => {
    const l = lay('B4:1/4 |');
    const head = glyphs(l, 'head')[0]!;
    const [stem] = lines(l, 'stem');
    expect(stem!.x1).toBeCloseTo(
      head.x + SMUFL_ANCHORS.noteheadBlack.stemDownNW[0] + STEM_W / 2,
      9,
    );
    expect(stem!.y1).toBeCloseTo(head.y + SMUFL_ANCHORS.noteheadBlack.stemDownNW[1], 9);
    expect(stem!.y2).toBeGreaterThan(stem!.y1);
    expect(l.notes[0]!.stemUp).toBe(false);
  });

  it('is 3.5 spaces long from the head center, or reaches the middle line if that is farther', () => {
    const near = lay('G4:1/4 D5:1/4 |');
    const [up, down] = lines(near, 'stem');
    expect(up!.y2).toBeCloseTo(3 - 3.5, 9);
    expect(down!.y2).toBeCloseTo(1 + 3.5, 9);
    const far = lay('G3:1/4 G6:1/4 |');
    const [lowStem, highStem] = lines(far, 'stem');
    expect(lowStem!.y2).toBe(2); // up from the open G: far longer than 3.5, ends at the middle line
    expect(highStem!.y2).toBe(2);
  });

  it('has no stem on a whole note and has one on a half note (with the open head)', () => {
    expect(lines(lay('G4:1/1 |'), 'stem')).toHaveLength(0);
    expect(lines(lay('G4:1/2 |'), 'stem')).toHaveLength(1);
  });

  it('tags the stem with its note', () => {
    expect(lines(lay('G4:1/4 A4:1/4 |'), 'stem').map((s) => s.noteIndex)).toEqual([0, 1]);
  });
});

describe('layoutScore: flags (unbeamed eighths and shorter)', () => {
  const flagNames = (spec: string) => glyphs(lay(spec), 'flag').map((g) => g.glyph);

  it('draws one flag per value, up on up stems and down on down stems', () => {
    expect(flagNames('G4:1/8 |')).toEqual(['flag8thUp']);
    expect(flagNames('G4:1/16 |')).toEqual(['flag16thUp']);
    expect(flagNames('G4:1/32 |')).toEqual(['flag32ndUp']);
    expect(flagNames('D5:1/8 |')).toEqual(['flag8thDown']);
    expect(flagNames('D5:1/16 |')).toEqual(['flag16thDown']);
    expect(flagNames('D5:1/32 |')).toEqual(['flag32ndDown']);
  });

  it('draws none for quarters and longer', () => {
    expect(flagNames('G4:1/4 G4:1/2 |')).toEqual([]);
  });

  it('attaches the flag at the stem tip using the font anchors', () => {
    const l = lay('G4:1/8 |');
    const [stem] = lines(l, 'stem');
    const [flag] = glyphs(l, 'flag');
    const anchor = SMUFL_ANCHORS.flag8thUp.stemUpNW;
    expect(flag!.x).toBeCloseTo(stem!.x1 - STEM_W / 2 - anchor[0], 9);
    expect(flag!.y).toBeCloseTo(stem!.y2 - anchor[1], 9);
    expect(flag!.noteIndex).toBe(0);

    const down = lay('D5:1/8 |');
    const [downStem] = lines(down, 'stem');
    const [downFlag] = glyphs(down, 'flag');
    const downAnchor = SMUFL_ANCHORS.flag8thDown.stemDownSW;
    expect(downFlag!.x).toBeCloseTo(downStem!.x1 - STEM_W / 2 - downAnchor[0], 9);
    expect(downFlag!.y).toBeCloseTo(downStem!.y2 - downAnchor[1], 9);
  });

  it('draws a triplet eighth as an eighth (the written value), flag included', () => {
    const l = lay('(3 G4:1/8 A4:1/8 B4:1/8 |');
    expect(glyphs(l, 'flag')).toHaveLength(3);
    expect(glyphs(l, 'head').every((h) => h.glyph === 'noteheadBlack')).toBe(true);
  });

  it('draws a triplet quarter as a quarter (no flag)', () => {
    const l = lay('(3 G4:1/4 A4:1/4 B4:1/4 |');
    expect(glyphs(l, 'flag')).toHaveLength(0);
    expect(glyphs(l, 'head').map((h) => h.glyph)).toEqual([
      'noteheadBlack',
      'noteheadBlack',
      'noteheadBlack',
    ]);
  });
});

// --- accidentals -----------------------------------------------------------------------------------

describe('layoutScore: accidentals', () => {
  it('draws the sign to the left of its head, level with it', () => {
    const l = lay('F#4:1/4 |');
    const [sign] = glyphs(l, 'accidental');
    const head = glyphs(l, 'head')[0]!;
    expect(sign!.glyph).toBe('accidentalSharp');
    expect(sign!.y).toBe(head.y);
    expect(sign!.x + STAFF_GLYPHS.accidentalSharp.width).toBeLessThanOrEqual(head.x);
    expect(sign!.noteIndex).toBe(0);
  });

  it('follows the printed-music rules: nothing for F-sharp in G major, a natural for F-natural', () => {
    expect(glyphs(lay('F#4:1/4 |', { key: 1 }), 'accidental')).toHaveLength(0);
    const natural = glyphs(lay('F4:1/4 |', { key: 1 }), 'accidental');
    expect(natural.map((g) => g.glyph)).toEqual(['accidentalNatural']);
  });

  it('draws each sign once per bar and again after the bar line', () => {
    const l = lay('F#4:1/4 F#4:1/4 F#4:1/4 F#4:1/4 | F#4:1/4 F#4:1/4 F#4:1/4 F#4:1/4 |');
    expect(glyphs(l, 'accidental').map((g) => g.noteIndex)).toEqual([0, 4]);
  });

  it('draws flats and double signs', () => {
    const l = lay('Bb4:1/4 F##4:1/4 Ebb5:1/4 |');
    expect(glyphs(l, 'accidental').map((g) => g.glyph)).toEqual([
      'accidentalFlat',
      'accidentalDoubleSharp',
      'accidentalDoubleFlat',
    ]);
  });

  it('makes room for the sign: the head is farther from the previous note than without it', () => {
    const plain = lay('G4:1/16 G4:1/16 |', undefined, { showTimeSignature: false });
    const signed = lay('G4:1/16 G#4:1/16 |', undefined, { showTimeSignature: false });
    expect(signed.notes[1]!.x - signed.notes[0]!.x).toBeGreaterThan(
      plain.notes[1]!.x - plain.notes[0]!.x,
    );
    const [sign] = glyphs(signed, 'accidental');
    expect(sign!.x).toBeGreaterThan(signed.notes[0]!.x + HEAD_W); // clear of the previous head
  });

  it('puts the sign only on the first head of a tied note', () => {
    const l = lay('F#4:5/8 G4:3/8 |');
    expect(glyphs(l, 'accidental')).toHaveLength(1);
  });
});

// --- ties and splitting ---------------------------------------------------------------------------------

describe('layoutScore: values that need tying', () => {
  it('draws 5/8 as a half and an eighth joined by a tie', () => {
    const l = lay('G4:5/8 A4:3/8 |');
    expect(l.notes[0]).toMatchObject({ noteIndex: 0, pieces: 2 });
    expect(l.notes[1]).toMatchObject({ noteIndex: 1, pieces: 1 });
    const heads = glyphs(l, 'head').filter((h) => h.noteIndex === 0);
    expect(heads.map((h) => h.glyph)).toEqual(['noteheadHalf', 'noteheadBlack']);
    const ties = paths(l, 'tie');
    expect(ties).toHaveLength(1);
    expect(ties[0]!.noteIndex).toBe(0);
    expect(ties[0]!.filled).toBe(true);
  });

  it('draws a long note as the fewest tied values (a whole and a quarter for 5/4)', () => {
    const l = lay('G4:1/1~ | G4:1/4 A4:3/4 |');
    expect(l.notes[0]!.pieces).toBe(2);
    const heads = glyphs(l, 'head').filter((h) => h.noteIndex === 0);
    expect(heads.map((h) => h.glyph)).toEqual(['noteheadWhole', 'noteheadBlack']);
    expect(paths(l, 'tie')).toHaveLength(1);
  });

  it('cuts a note that runs over a bar line at the line and ties the parts', () => {
    const l = lay('G4:1/2 A4:1/4 B4:1/4~ | B4:1/2 C5:1/2 |');
    const b = l.notes.find((n) => n.noteIndex === 2)!;
    expect(b.pieces).toBe(2);
    const [tie] = paths(l, 'tie');
    const [, barLine] = l.barLines;
    const [minX, , maxX] = primitiveBounds(tie!);
    expect(minX).toBeLessThan(l.barLines[0]!.x);
    expect(maxX).toBeGreaterThan(l.barLines[0]!.x);
    expect(barLine).toBeDefined();
    // The two heads of B4 sit in different bars.
    const heads = glyphs(l, 'head').filter((h) => h.noteIndex === 2);
    expect(heads[0]!.x).toBeLessThan(l.barLines[0]!.x);
    expect(heads[1]!.x).toBeGreaterThan(l.barLines[0]!.x);
    expect(heads.map((h) => h.glyph)).toEqual(['noteheadBlack', 'noteheadHalf']);
  });

  it('cuts at every bar line a very long note crosses', () => {
    const l = lay('G4:1/2 A4:1/4 B4:1/4~ | B4:1/1~ | B4:1/4 C5:3/4 |');
    expect(l.notes.find((n) => n.noteIndex === 2)!.pieces).toBe(3);
    expect(paths(l, 'tie')).toHaveLength(2);
  });

  it('puts the tie below the heads when the stem is up and above them when it is down', () => {
    const up = lay('G4:5/8 A4:3/8 |');
    const upHead = glyphs(up, 'head')[0]!;
    expect(primitiveBounds(paths(up, 'tie')[0]!)[1]).toBeGreaterThan(upHead.y);
    const down = lay('D5:5/8 C5:3/8 |');
    const downHead = glyphs(down, 'head')[0]!;
    expect(primitiveBounds(paths(down, 'tie')[0]!)[3]).toBeLessThan(downHead.y);
  });

  it('runs the tie from the first head to the second', () => {
    const l = lay('G4:5/8 A4:3/8 |');
    const [first, second] = glyphs(l, 'head').filter((h) => h.noteIndex === 0);
    const [minX, , maxX] = primitiveBounds(paths(l, 'tie')[0]!);
    expect(minX).toBeGreaterThanOrEqual(first!.x + HEAD_W);
    expect(maxX).toBeLessThanOrEqual(second!.x);
  });

  it('gives a tie that runs off the right edge of the window a short stub', () => {
    const l = lay('G4:1/2 A4:1/4 B4:1/4~ | B4:1/2 C5:1/2 |', undefined, { maxBars: 1 });
    expect(l.lastBar).toBe(0);
    expect(l.notes.find((n) => n.noteIndex === 2)!.pieces).toBe(1);
    const ties = paths(l, 'tie');
    expect(ties).toHaveLength(1);
    expect(ties[0]!.noteIndex).toBe(2);
    const head = glyphs(l, 'head').find((h) => h.noteIndex === 2)!;
    const [minX, , maxX] = primitiveBounds(ties[0]!);
    expect(minX).toBeGreaterThanOrEqual(head.x + HEAD_W);
    expect(maxX - minX).toBeLessThan(3);
    expectInsideViewBox(l);
  });

  it('shows the rest of a note tied in from the previous window, with a stub entering from the left', () => {
    const l = lay('G4:1/2 A4:1/4 B4:1/4~ | B4:1/2 C5:1/2 |', undefined, { firstBar: 1 });
    expect(l.firstBar).toBe(1);
    const b = l.notes.find((n) => n.noteIndex === 2)!;
    expect(b.pieces).toBe(1);
    const head = glyphs(l, 'head').find((h) => h.noteIndex === 2)!;
    expect(head.glyph).toBe('noteheadHalf');
    const ties = paths(l, 'tie');
    expect(ties).toHaveLength(1);
    const [, , maxX] = primitiveBounds(ties[0]!);
    expect(maxX).toBeLessThanOrEqual(head.x);
    expect(glyphs(l, 'accidental')).toHaveLength(0);
    expectInsideViewBox(l);
  });

  it('shows every note that has a head in the window, once', () => {
    const l = lay('G4:1/2 A4:1/4 B4:1/4~ | B4:1/2 C5:1/2 |', undefined, { firstBar: 1 });
    expect(l.notes.map((n) => n.noteIndex)).toEqual([2, 3]);
  });
});

// --- beams ---------------------------------------------------------------------------------------------

/** Outer-edge y of a beam polygon at x (the first two points are the outer edge of the primary beam). */
function beamOuterY(beam: Polygon, x: number): number {
  const [a, b] = beam.points;
  return a![1] + ((x - a![0]) / (b![0] - a![0])) * (b![1] - a![1]);
}

describe('layoutScore: beams', () => {
  it('beams consecutive eighths written without a gap, with no flags', () => {
    const l = lay('^G4:1/8 ^A4:1/8 |');
    expect(polygons(l, 'beam')).toHaveLength(1);
    expect(glyphs(l, 'flag')).toHaveLength(0);
    expect(lines(l, 'stem')).toHaveLength(2);
  });

  it('flags the notes of an eighth pair that is *not* written beamed', () => {
    const l = lay('G4:1/8 A4:1/8 |');
    expect(polygons(l, 'beam')).toHaveLength(0);
    expect(glyphs(l, 'flag')).toHaveLength(2);
  });

  it('makes one beam of a group of four and separate beams for separate groups', () => {
    expect(polygons(lay('^G4:1/8 ^A4:1/8 ^B4:1/8 ^C5:1/8 |'), 'beam')).toHaveLength(1);
    expect(polygons(lay('^G4:1/8 ^A4:1/8 B4:1/8 ^C5:1/8 |'), 'beam')).toHaveLength(2);
  });

  it('does not beam a lone note, a quarter with an eighth, or notes in different bars', () => {
    expect(polygons(lay('^G4:1/8 |'), 'beam')).toHaveLength(0);
    expect(polygons(lay('G4:1/4 ^A4:1/8 |'), 'beam')).toHaveLength(0);
    const across = lay('G4:1/2 A4:1/4 B4:1/8 ^C5:1/8 | ^D5:1/8 ^E5:1/8 F5:1/4 G5:1/2 |');
    // C5 and D5 are written beamed, but sit either side of a bar line.
    expect(polygons(across, 'beam')).toHaveLength(2);
    const beamNotes = (poly: Polygon) => poly.points[0]![0];
    const [first, second] = polygons(across, 'beam');
    expect(beamNotes(first!)).toBeLessThan(across.barLines[0]!.x);
    expect(beamNotes(second!)).toBeGreaterThan(across.barLines[0]!.x);
  });

  it('breaks the group at a rest, visible or not', () => {
    expect(polygons(lay('^G4:1/8 ^A4:1/8 z:1/8 ^B4:1/8 ^C5:1/8 |'), 'beam')).toHaveLength(2);
    expect(polygons(lay('^G4:1/8 ^A4:1/8 x:1/8 ^B4:1/8 ^C5:1/8 |'), 'beam')).toHaveLength(2);
  });

  it('does not beam a note that is tied into several heads', () => {
    const l = lay('^G4:1/8 ^A4:5/16 ^B4:1/8 |');
    expect(l.notes.find((n) => n.noteIndex === 1)!.pieces).toBe(2);
    expect(polygons(l, 'beam')).toHaveLength(0);
  });

  it('draws a second beam for sixteenths and a third for 32nds', () => {
    expect(polygons(lay('^G4:1/16 ^A4:1/16 ^B4:1/16 ^C5:1/16 |'), 'beam')).toHaveLength(2);
    expect(polygons(lay('^G4:1/32 ^A4:1/32 ^B4:1/32 ^C5:1/32 |'), 'beam')).toHaveLength(3);
  });

  it('draws the secondary beam only across the notes that carry it', () => {
    const l = lay('^G4:1/8 ^A4:1/16 ^B4:1/16 ^C5:1/8 |');
    const beams = polygons(l, 'beam');
    expect(beams).toHaveLength(2);
    const stems = lines(l, 'stem');
    const [primary, secondary] = beams;
    const xs = (poly: Polygon) => [
      Math.min(...poly.points.map((p) => p[0])),
      Math.max(...poly.points.map((p) => p[0])),
    ];
    expect(xs(primary!)[0]).toBeCloseTo(stems[0]!.x1 - STEM_W / 2, 6);
    expect(xs(primary!)[1]).toBeCloseTo(stems[3]!.x1 + STEM_W / 2, 6);
    expect(xs(secondary!)[0]).toBeCloseTo(stems[1]!.x1 - STEM_W / 2, 6);
    expect(xs(secondary!)[1]).toBeCloseTo(stems[2]!.x1 + STEM_W / 2, 6);
  });

  it('draws a partial beam (stub) on a lone sixteenth, toward the note it shares a beat with', () => {
    // Dotted eighth + sixteenth: the sixteenth's stub points back at the dotted eighth.
    const l = lay('^G4:3/16 ^A4:1/16 |');
    const beams = polygons(l, 'beam');
    expect(beams).toHaveLength(2);
    const stems = lines(l, 'stem');
    const [, stub] = beams;
    const xs = stub!.points.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(stems[1]!.x1 + STEM_W / 2, 6); // ends at the sixteenth's stem
    expect(Math.min(...xs)).toBeLessThan(stems[1]!.x1 - 0.5); // and reaches back toward the first
    // Sixteenth + dotted eighth: the stub points forward instead.
    const forward = polygons(lay('^G4:1/16 ^A4:3/16 |'), 'beam');
    const forwardStems = lines(lay('^G4:1/16 ^A4:3/16 |'), 'stem');
    const forwardXs = forward[1]!.points.map((p) => p[0]);
    expect(Math.min(...forwardXs)).toBeCloseTo(forwardStems[0]!.x1 - STEM_W / 2, 6);
    expect(Math.max(...forwardXs)).toBeGreaterThan(forwardStems[0]!.x1 + 0.5);
  });

  it('gives every stem a direction shared by the group, chosen by the head farthest from the middle line', () => {
    // E4 is far below the middle line, D5 only a little above: the whole group stems up.
    const up = lay('^E4:1/8 ^D5:1/8 ^E4:1/8 ^D5:1/8 |');
    expect(up.notes.every((n) => n.stemUp)).toBe(true);
    // The mirror image: stems down.
    const down = lay('^D5:1/8 ^E4:1/8 ^D5:1/8 ^A5:1/8 |');
    expect(down.notes.every((n) => !n.stemUp)).toBe(true);
    // A tie in distance goes down.
    const tie = lay('^A4:1/8 ^C5:1/8 |'); // 1 below, 1 above
    expect(tie.notes.every((n) => !n.stemUp)).toBe(true);
  });

  it('reaches every stem to the beam, never shorter than 2.5 spaces, with a gentle slope', () => {
    const specs = [
      '^G4:1/8 ^A4:1/8 ^B4:1/8 ^C5:1/8 |',
      '^C5:1/8 ^B4:1/8 ^A4:1/8 ^G4:1/8 |',
      '^G3:1/8 ^E5:1/8 ^G3:1/8 ^E5:1/8 |',
      '^C5:1/8 ^C6:1/8 |',
      '^G6:1/8 ^G3:1/8 |',
      '^G4:1/16 ^A4:1/16 ^B4:1/16 ^C5:1/16 ^D5:1/16 ^E5:1/16 ^F5:1/16 ^G5:1/16 |',
      '^G4:1/32 ^A4:1/32 ^B4:1/32 ^C5:1/32 |',
      '^E5:1/8 ^D5:1/8 ^E5:1/8 ^D5:1/8 |',
    ];
    for (const spec of specs) {
      const l = lay(spec);
      const beam = polygons(l, 'beam')[0]!;
      const stems = lines(l, 'stem');
      const heads = glyphs(l, 'head');
      expect(stems).toHaveLength(heads.length);
      stems.forEach((stem, i) => {
        expect(stem.y2).toBeCloseTo(beamOuterY(beam, stem.x1), 6);
        const length = Math.abs(stem.y2 - heads[i]!.y);
        expect(length).toBeGreaterThanOrEqual(2.5 - 1e-9);
        // Stem direction matches the group.
        expect(Math.sign(stem.y2 - stem.y1)).toBe(l.notes[i]!.stemUp ? -1 : 1);
      });
      const [a, b] = beam.points;
      const slope = (b![1] - a![1]) / (b![0] - a![0]);
      expect(Math.abs(slope)).toBeLessThanOrEqual(0.25 + 1e-9);
    }
  });

  it('draws a beam of fixed thickness hanging inward from the stem tips', () => {
    const up = polygons(lay('^G4:1/8 ^A4:1/8 |'), 'beam')[0]!;
    expect(up.points[3]![1] - up.points[0]![1]).toBeCloseTo(SMUFL_ENGRAVING.beamThickness, 9);
    const down = polygons(lay('^D5:1/8 ^E5:1/8 |'), 'beam')[0]!;
    expect(down.points[0]![1] - down.points[3]![1]).toBeCloseTo(SMUFL_ENGRAVING.beamThickness, 9);
  });

  it('spaces the secondary beams by the font beam spacing', () => {
    const l = lay('^G4:1/16 ^A4:1/16 ^B4:1/16 ^C5:1/16 |');
    const [primary, secondary] = polygons(l, 'beam');
    expect(secondary!.points[0]![1] - primary!.points[0]![1]).toBeCloseTo(
      SMUFL_ENGRAVING.beamThickness + SMUFL_ENGRAVING.beamSpacing,
      6,
    );
  });

  it('rises with an ascending group and falls with a descending one (stems up)', () => {
    const asc = polygons(lay('^E4:1/8 ^F4:1/8 ^G4:1/8 ^A4:1/8 |'), 'beam')[0]!;
    expect(asc.points[1]![1]).toBeLessThan(asc.points[0]![1]);
    const desc = polygons(lay('^A4:1/8 ^G4:1/8 ^F4:1/8 ^E4:1/8 |'), 'beam')[0]!;
    expect(desc.points[1]![1]).toBeGreaterThan(desc.points[0]![1]);
  });

  it('keeps the beam flat when the line goes up and comes back', () => {
    const l = polygons(lay('^E4:1/8 ^G4:1/8 ^B4:1/8 ^G4:1/8 |'), 'beam')[0]!;
    expect(l.points[1]![1]).toBeCloseTo(l.points[0]![1], 9);
  });

  it('tags stems with their note but beams with none', () => {
    const l = lay('^G4:1/8 ^A4:1/8 |');
    expect(lines(l, 'stem').map((s) => s.noteIndex)).toEqual([0, 1]);
    expect(polygons(l, 'beam').every((b) => b.noteIndex === undefined)).toBe(true);
  });
});

// --- tuplets --------------------------------------------------------------------------------------------

describe('layoutScore: tuplets', () => {
  it('draws only the number over a triplet that is beamed as one group', () => {
    const l = lay('(3 G4:1/8 ^A4:1/8 ^B4:1/8 C5:1/4 |');
    expect(glyphs(l, 'tuplet').map((g) => g.glyph)).toEqual(['tuplet3']);
    expect(paths(l, 'tuplet')).toHaveLength(0);
    expect(polygons(l, 'beam')).toHaveLength(1);
  });

  it('puts the number beyond the beam on the stem side', () => {
    const up = lay('(3 G4:1/8 ^A4:1/8 ^B4:1/8 |');
    const upBeam = polygons(up, 'beam')[0]!;
    const upNumber = glyphs(up, 'tuplet')[0]!;
    const topOfBeam = Math.min(...upBeam.points.map((p) => p[1]));
    expect(primitiveBounds(upNumber)[3]).toBeLessThan(topOfBeam);

    const down = lay('(3 G5:1/8 ^A5:1/8 ^B5:1/8 |');
    const downBeam = polygons(down, 'beam')[0]!;
    const downNumber = glyphs(down, 'tuplet')[0]!;
    const bottomOfBeam = Math.max(...downBeam.points.map((p) => p[1]));
    expect(primitiveBounds(downNumber)[1]).toBeGreaterThan(bottomOfBeam);
  });

  it('centers the number over the group', () => {
    const l = lay('(3 G4:1/8 ^A4:1/8 ^B4:1/8 |');
    const [number] = glyphs(l, 'tuplet');
    const stems = lines(l, 'stem');
    const [minX, , maxX] = primitiveBounds(number!);
    expect((minX + maxX) / 2).toBeCloseTo((stems[0]!.x1 + stems[2]!.x1) / 2, 0);
  });

  it('draws a bracket with the number for a triplet that is not beamed as one group', () => {
    const l = lay('(3 G4:1/4 A4:1/4 B4:1/4 C5:1/2 |');
    expect(glyphs(l, 'tuplet').map((g) => g.glyph)).toEqual(['tuplet3']);
    const brackets = paths(l, 'tuplet');
    expect(brackets).toHaveLength(1);
    expect(brackets[0]!.filled).toBe(false);
    expect(brackets[0]!.width).toBe(SMUFL_ENGRAVING.tupletBracketThickness);
  });

  it('draws a bracket when a rest is part of the triplet', () => {
    const l = lay('(3 ^G4:1/8 z:1/8 ^B4:1/8 C5:1/4 |');
    expect(paths(l, 'tuplet')).toHaveLength(1);
  });

  it('sits the bracket beyond the stem tips: above up stems, below down stems', () => {
    const up = lay('(3 G4:1/4 A4:1/4 B4:1/4 |');
    const stemTop = Math.min(...lines(up, 'stem').map((s) => s.y2));
    expect(primitiveBounds(paths(up, 'tuplet')[0]!)[3]).toBeLessThan(stemTop);
    const down = lay('(3 G5:1/4 A5:1/4 B5:1/4 |');
    const stemBottom = Math.max(...lines(down, 'stem').map((s) => s.y2));
    expect(primitiveBounds(paths(down, 'tuplet')[0]!)[1]).toBeGreaterThan(stemBottom);
  });

  it('gives the notes of a tuplet one stem direction even when unbeamed', () => {
    // G4 is below the middle line, B4 on it: the pair would differ if decided alone; the group follows G4.
    const l = lay('(3 G4:1/4 B4:1/4 B4:1/4 |');
    expect(l.notes.map((n) => n.stemUp)).toEqual([true, true, true]);
  });

  it('draws the written number for other tuplets, two digits where needed', () => {
    const quint = lay('(5/4 ^C5:1/16 ^D5:1/16 ^E5:1/16 ^F5:1/16 ^G5:1/16 |');
    expect(glyphs(quint, 'tuplet').map((g) => g.glyph)).toEqual(['tuplet5']);
    const eleven = lay(
      '(11/8 C5:1/16 D5:1/16 E5:1/16 F5:1/16 G5:1/16 A5:1/16 B5:1/16 C6:1/16 D6:1/16 E6:1/16 F6:1/16 |',
    );
    expect(glyphs(eleven, 'tuplet').map((g) => g.glyph)).toEqual(['tuplet1', 'tuplet1']);
  });

  it('carries no note index on tuplet marks', () => {
    const l = lay('(3 G4:1/4 A4:1/4 B4:1/4 |');
    expect(glyphs(l, 'tuplet').every((g) => g.noteIndex === undefined)).toBe(true);
    expect(paths(l, 'tuplet').every((g) => g.noteIndex === undefined)).toBe(true);
  });

  it('spaces triplet notes by their sounding length (shorter than the written value)', () => {
    const triplet = lay('(3 G4:1/8 A4:1/8 B4:1/8 |', undefined, { showTimeSignature: false });
    const plain = lay('G4:1/8 A4:1/8 B4:1/8 |', undefined, { showTimeSignature: false });
    const gap = (l: ScoreLayout) => l.notes[1]!.x - l.notes[0]!.x;
    expect(gap(triplet)).toBeLessThan(gap(plain));
  });
});

// --- rests ------------------------------------------------------------------------------------------------

describe('layoutScore: rests', () => {
  const restGlyphs = (spec: string, options?: BuildPieceOptions) =>
    glyphs(lay(spec, options), 'rest').map((g) => g.glyph);

  it('draws each value with its own glyph', () => {
    // Bars are filled so none of them is a whole-bar rest.
    expect(restGlyphs('z:1/2 z:1/2 |')).toEqual(['restHalf', 'restHalf']);
    expect(restGlyphs('z:1/4 z:1/4 z:1/2 |')).toEqual(['restQuarter', 'restQuarter', 'restHalf']);
    expect(restGlyphs('z:1/8 z:1/8 z:1/4 z:1/2 |')).toEqual([
      'rest8th',
      'rest8th',
      'restQuarter',
      'restHalf',
    ]);
    expect(restGlyphs('z:1/16 z:1/16 z:1/8 z:1/4 z:1/2 |')).toEqual([
      'rest16th',
      'rest16th',
      'rest8th',
      'restQuarter',
      'restHalf',
    ]);
    expect(restGlyphs('z:1/32 z:1/32 z:1/16 z:1/8 z:1/4 z:1/2 |')).toEqual([
      'rest32nd',
      'rest32nd',
      'rest16th',
      'rest8th',
      'restQuarter',
      'restHalf',
    ]);
  });

  it('hangs the whole rest from the second line and sits the half rest on the middle line', () => {
    const whole = lay('z:1/1 |');
    expect(glyphs(whole, 'rest')[0]).toMatchObject({ glyph: 'restWhole', y: 1 });
    const half = lay('G4:1/2 z:1/2 |');
    expect(glyphs(half, 'rest')[0]).toMatchObject({ glyph: 'restHalf', y: 2 });
  });

  it('places the quarter and shorter rests from the middle line', () => {
    const l = lay('z:1/4 z:1/8 z:1/16 z:1/32 z:1/32 z:1/2 |');
    for (const g of glyphs(l, 'rest')) expect(g.y).toBe(2);
  });

  it('centers a whole-bar rest in the bar, in any meter, as a whole rest', () => {
    for (const meter of ['4/4', '3/4', '6/8']) {
      const bar = meter === '4/4' ? 'z:1/1' : 'z:3/4';
      const l = lay(`${bar} | ${bar} |`, { meter });
      const rests = glyphs(l, 'rest');
      expect(rests.map((r) => r.glyph)).toEqual(['restWhole', 'restWhole']);
      const width = STAFF_GLYPHS.restWhole.width;
      // Second bar spans from the first bar line to the second.
      const left = l.barLines[0]!.x;
      const right = l.barLines[1]!.x;
      const center = rests[1]!.x + width / 2;
      expect(center).toBeGreaterThan(left + (right - left) * 0.35);
      expect(center).toBeLessThan(left + (right - left) * 0.65);
    }
  });

  it('draws each bar of a rest that spans several bars as a centered whole-bar rest', () => {
    const two = build('z:1/1 | z:1/1 |');
    const spanning: AbcPiece = {
      ...two,
      elements: two.elements.flatMap((e): AbcScoreElement[] => {
        if (e.type !== 'rest') return [e];
        return e.start === 0 ? [{ ...e, duration: 2, notated: 2 }] : [];
      }),
    };
    const l = layoutScore(spanning, { firstBar: 0, widthSpaces: 300 });
    expect(glyphs(l, 'rest').map((g) => g.glyph)).toEqual(['restWhole', 'restWhole']);
    const [first, second] = glyphs(l, 'rest');
    const width = STAFF_GLYPHS.restWhole.width;
    const [left, right] = [l.barLines[0]!.x, l.barLines[1]!.x];
    expect(second!.x + width / 2).toBeGreaterThan(left + (right - left) * 0.35);
    expect(second!.x + width / 2).toBeLessThan(left + (right - left) * 0.65);
    expect(first!.x).toBeLessThan(left);
  });

  it('draws an invisible rest as nothing, but it still takes up time and space', () => {
    const visible = lay('G4:1/4 z:1/4 A4:1/4 z:1/4 |');
    const invisible = lay('G4:1/4 x:1/4 A4:1/4 z:1/4 |');
    expect(glyphs(invisible, 'rest')).toHaveLength(1);
    expect(glyphs(visible, 'rest')).toHaveLength(2);
    expect(invisible.notes[1]!.x).toBeCloseTo(visible.notes[1]!.x, 9);
  });

  it('cuts a rest that is no single value into several rests (5/8 = half + eighth)', () => {
    expect(restGlyphs('G4:3/8 z:5/8 |')).toEqual(['restHalf', 'rest8th']);
  });

  it('dots a dotted rest', () => {
    const l = lay('z:3/8 z:3/8 z:1/4 |');
    expect(glyphs(l, 'rest').map((g) => g.glyph)).toEqual([
      'restQuarter',
      'restQuarter',
      'restQuarter',
    ]);
    expect(glyphs(l, 'dot')).toHaveLength(2);
  });

  it('carries no note index', () => {
    const l = lay('z:1/4 G4:1/4 z:1/2 |');
    expect(glyphs(l, 'rest').every((g) => g.noteIndex === undefined)).toBe(true);
  });

  it('leaves rests out of the list of notes', () => {
    expect(lay('z:1/4 G4:1/4 z:1/2 |').notes.map((n) => n.noteIndex)).toEqual([0]);
  });
});

// --- bar lines -----------------------------------------------------------------------------------------------

describe('layoutScore: bar lines', () => {
  const barLinePrimitives = (l: ScoreLayout) => lines(l, 'bar-line');

  it('draws a thin line to close a bar and none at the very start', () => {
    const l = lay('G4:1/1 | A4:1/1 |');
    const bars = barLinePrimitives(l);
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => b.width === SMUFL_ENGRAVING.thinBarlineThickness)).toBe(true);
    expect(l.barLines.map((b) => b.bar)).toEqual([0, 1]);
    expect(bars[0]!.x1).toBeGreaterThan(glyphs(l, 'head')[0]!.x);
  });

  it('spans the staff (at least y = 0..4)', () => {
    const [bar] = barLinePrimitives(lay('G4:1/1 |'));
    expect(bar!.y1).toBeLessThanOrEqual(0);
    expect(bar!.y2).toBeGreaterThanOrEqual(4);
    expect(bar!.x1).toBe(bar!.x2);
  });

  it('draws a double bar line as two thin lines', () => {
    const bars = barLinePrimitives(lay('G4:1/1 || A4:1/1 |'));
    expect(bars).toHaveLength(3);
    expect(bars[0]!.x1).toBeLessThan(bars[1]!.x1);
    expect(bars[1]!.x1 - bars[0]!.x1).toBeGreaterThan(SMUFL_ENGRAVING.barlineSeparation);
  });

  it('draws a final bar line as a thin line then a thick one', () => {
    const bars = barLinePrimitives(lay('G4:1/1 |]'));
    expect(bars).toHaveLength(2);
    expect(bars[0]!.width).toBe(SMUFL_ENGRAVING.thinBarlineThickness);
    expect(bars[1]!.width).toBe(SMUFL_ENGRAVING.thickBarlineThickness);
    expect(bars[1]!.x1).toBeGreaterThan(bars[0]!.x1);
  });

  it('closes the last bar of a piece with a final bar line when the source gave none', () => {
    const bars = barLinePrimitives(lay('G4:1/1 | A4:1/1'));
    expect(bars).toHaveLength(3); // thin (bar 0) + thin and thick (the closing final line)
    expect(bars[2]!.width).toBe(SMUFL_ENGRAVING.thickBarlineThickness);
  });

  it('draws a start-repeat as thick + thin + two dots after the line', () => {
    const l = lay('|: G4:1/1 | A4:1/1 :|');
    const start = barLinePrimitives(l).slice(0, 2);
    expect(start.map((b) => b.width)).toEqual([
      SMUFL_ENGRAVING.thickBarlineThickness,
      SMUFL_ENGRAVING.thinBarlineThickness,
    ]);
    // A repeat-start before any music has no bar to end, so it opens the window.
    expect(l.barLines[0]).toMatchObject({ bar: -1 });
    const dots = circles(l, 'bar-line');
    expect(dots.length).toBeGreaterThanOrEqual(4); // two for the start sign, two for the end sign
    for (const dot of dots.slice(0, 2)) expect(dot.cx).toBeGreaterThan(start[1]!.x1);
    expect(dots.slice(0, 2).map((d) => d.cy)).toEqual([1.5, 2.5]);
  });

  it('draws an end-repeat as two dots + thin + thick, dots to the left', () => {
    const l = lay('G4:1/1 :|');
    const bars = barLinePrimitives(l);
    expect(bars.map((b) => b.width)).toEqual([
      SMUFL_ENGRAVING.thinBarlineThickness,
      SMUFL_ENGRAVING.thickBarlineThickness,
    ]);
    const dots = circles(l, 'bar-line');
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.cx).toBeLessThan(bars[0]!.x1);
  });

  it('draws a both-way repeat as two thin lines with dots on both outer sides', () => {
    const l = lay('G4:1/1 :|: A4:1/1 |');
    const [left, right] = barLinePrimitives(l);
    const dots = circles(l, 'bar-line');
    expect(dots).toHaveLength(4);
    expect(dots.filter((d) => d.cx < left!.x1)).toHaveLength(2);
    expect(dots.filter((d) => d.cx > right!.x1)).toHaveLength(2);
  });

  it('opens a window with a start-repeat when the previous bar line was one', () => {
    const l = lay('G4:1/1 |: A4:1/1 | B4:1/1 :| C5:1/1 |', undefined, { firstBar: 1 });
    expect(l.barLines[0]).toMatchObject({ bar: 0 });
    const first = barLinePrimitives(l)[0]!;
    expect(first.width).toBe(SMUFL_ENGRAVING.thickBarlineThickness);
    expect(first.x1).toBeGreaterThan(0.3 + STAFF_GLYPHS.gClef.width); // clear of the clef
    expect(glyphs(l, 'head')[0]!.x).toBeGreaterThan(first.x1);
  });

  it('does not open a window with an ordinary bar line', () => {
    const l = lay('G4:1/1 | A4:1/1 | B4:1/1 |', undefined, { firstBar: 1 });
    expect(l.barLines.map((b) => b.bar)).toEqual([1, 2]);
  });
});

// --- windows ---------------------------------------------------------------------------------------------------

const FOUR_BARS =
  'C5:1/4 D5:1/4 E5:1/4 F5:1/4 | G5:1/4 A5:1/4 B5:1/4 C6:1/4 | D5:1/4 E5:1/4 F5:1/4 G5:1/4 | C5:1/1 |';

describe('layoutScore: choosing the bars of a window', () => {
  it('lays out as many consecutive bars as fit, never fewer than one', () => {
    const wide = lay(FOUR_BARS, undefined, { widthSpaces: 300 });
    expect(wide.firstBar).toBe(0);
    expect(wide.lastBar).toBe(3);
    const narrow = lay(FOUR_BARS, undefined, { widthSpaces: 55 });
    expect(narrow.lastBar).toBe(1);
    const oneBar = lay(FOUR_BARS, undefined, { widthSpaces: 40 });
    expect(oneBar.lastBar).toBe(0);
    const tiny = lay(FOUR_BARS, undefined, { widthSpaces: 1 });
    expect(tiny.lastBar).toBe(0);
  });

  it('never needs more than the width unless even the first bar does not fit', () => {
    for (let width = 12; width <= 120; width += 3) {
      const l = lay(FOUR_BARS, undefined, { widthSpaces: width });
      if (l.overflow) {
        expect(l.lastBar).toBe(l.firstBar);
        expect(l.widthSpaces).toBeGreaterThan(width);
      } else {
        expect(l.widthSpaces).toBeLessThanOrEqual(width + 1e-9);
      }
    }
  });

  it('flags overflow only when the first bar alone is too wide, and then lays out the one bar anyway', () => {
    const l = lay(FOUR_BARS, undefined, { widthSpaces: 10 });
    expect(l.overflow).toBe(true);
    expect(l.lastBar).toBe(0);
    expect(l.viewBox[2]).toBeCloseTo(l.widthSpaces, 6);
    expect(lay(FOUR_BARS, undefined, { widthSpaces: 60 }).overflow).toBe(false);
  });

  it('honours maxBars', () => {
    expect(lay(FOUR_BARS, undefined, { maxBars: 2 }).lastBar).toBe(1);
    expect(lay(FOUR_BARS, undefined, { maxBars: 1 }).lastBar).toBe(0);
    expect(lay(FOUR_BARS, undefined, { maxBars: 0 }).lastBar).toBe(0);
  });

  it('starts at firstBar and clamps it into the piece', () => {
    const piece = build(FOUR_BARS);
    const at = (firstBar: number) => layoutScore(piece, { firstBar, widthSpaces: 300 });
    expect(at(2).firstBar).toBe(2);
    expect(at(2).lastBar).toBe(3);
    expect(at(-5).firstBar).toBe(0);
    expect(at(99).firstBar).toBe(3);
    expect(at(Number.NaN).firstBar).toBe(0);
    expect(at(1.9).firstBar).toBe(1);
  });

  it('shows only the notes of its bars', () => {
    const l = lay(FOUR_BARS, undefined, { firstBar: 1, maxBars: 2 });
    expect(l.notes.map((n) => n.noteIndex)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('returns the same window for the same input', () => {
    const piece = build(FOUR_BARS);
    const a = layoutScore(piece, { firstBar: 1, widthSpaces: 55 });
    const b = layoutScore(piece, { firstBar: 1, widthSpaces: 55 });
    expect(a.primitives).toEqual(b.primitives);
    expect(a.viewBox).toEqual(b.viewBox);
  });
});

describe('layoutScore: justification', () => {
  it('stretches the bars toward the full width when more bars follow', () => {
    const natural = lay(FOUR_BARS, undefined, { widthSpaces: 55, justify: false });
    const justified = lay(FOUR_BARS, undefined, { widthSpaces: 55, justify: true });
    expect(justified.lastBar).toBe(natural.lastBar);
    const lastNatural = natural.barLines[natural.barLines.length - 1]!.x;
    const lastJustified = justified.barLines[justified.barLines.length - 1]!.x;
    expect(lastJustified).toBeGreaterThan(lastNatural);
    expect(lastJustified).toBeLessThanOrEqual(55 + 1e-9);
  });

  it('never stretches past the width or by more than about a third', () => {
    for (let width = 22; width <= 140; width += 2) {
      const l = lay(FOUR_BARS, undefined, { widthSpaces: width, justify: true });
      expect(l.viewBox[2]).toBeGreaterThanOrEqual(width - 1e-9);
      if (!l.overflow) {
        expect(l.viewBox[2]).toBeCloseTo(width, 9);
        const lastX = l.barLines[l.barLines.length - 1]!.x;
        expect(lastX).toBeLessThanOrEqual(width);
        expect(lastX).toBeLessThanOrEqual((l.widthSpaces - 1) * 1.35);
      }
    }
  });

  it('does not stretch the last window of a piece', () => {
    const natural = lay(FOUR_BARS, undefined, { firstBar: 2, widthSpaces: 300, justify: false });
    const justified = lay(FOUR_BARS, undefined, { firstBar: 2, widthSpaces: 300, justify: true });
    expect(justified.primitives).toEqual(natural.primitives);
  });

  it('keeps notes in order and clear of each other when stretched', () => {
    const l = lay(FOUR_BARS, undefined, { widthSpaces: 55, justify: true });
    for (let i = 1; i < l.notes.length; i += 1) {
      expect(l.notes[i]!.x).toBeGreaterThan(l.notes[i - 1]!.x + HEAD_W);
    }
  });
});

describe('layoutScore: key and time signatures', () => {
  const keyGlyphs = (l: ScoreLayout) => glyphs(l, 'key-signature');
  const timeGlyphs = (l: ScoreLayout) => glyphs(l, 'time-signature');
  const THREE_SHARPS = { key: 3 };

  it('draws the key signature in every window, not only the first', () => {
    const piece = build(FOUR_BARS, THREE_SHARPS);
    for (const firstBar of [0, 1, 2, 3]) {
      const l = layoutScore(piece, { firstBar, widthSpaces: 300 });
      expect(keyGlyphs(l).map((g) => g.glyph)).toEqual([
        'accidentalSharp',
        'accidentalSharp',
        'accidentalSharp',
      ]);
    }
  });

  it('places signature signs at the standard heights and left to right', () => {
    const l = lay('G4:1/1 |', { key: 3 });
    expect(keyGlyphs(l).map((g) => g.y)).toEqual([0, 1.5, -0.5]); // F5, C5, G5
    const xs = keyGlyphs(l).map((g) => g.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBeGreaterThan(0.3 + STAFF_GLYPHS.gClef.width);
  });

  it('draws flats for flat keys', () => {
    const l = lay('G4:1/1 |', { key: -2 });
    expect(keyGlyphs(l).map((g) => g.glyph)).toEqual(['accidentalFlat', 'accidentalFlat']);
    expect(keyGlyphs(l).map((g) => g.y)).toEqual([2, 0.5]); // B4, E5
  });

  it('draws no key signature for C major', () => {
    expect(keyGlyphs(lay('G4:1/1 |'))).toHaveLength(0);
  });

  it('draws the time signature as stacked digits centered on the staff, in the first window only', () => {
    const first = lay(FOUR_BARS);
    expect(timeGlyphs(first).map((g) => [g.glyph, g.y])).toEqual([
      ['timeSig4', 1],
      ['timeSig4', 3],
    ]);
    expect(timeGlyphs(lay(FOUR_BARS, undefined, { firstBar: 1 }))).toHaveLength(0);
  });

  it('draws it in a later window if asked, and not in the first if told not to', () => {
    expect(
      timeGlyphs(lay(FOUR_BARS, undefined, { firstBar: 1, showTimeSignature: true })),
    ).toHaveLength(2);
    expect(timeGlyphs(lay(FOUR_BARS, undefined, { showTimeSignature: false }))).toHaveLength(0);
  });

  it('centers two-digit time signatures over each other', () => {
    const l = lay('G4:3/4 | G4:3/4 |', { meter: '12/8' });
    const digits = timeGlyphs(l);
    expect(digits.map((g) => g.glyph)).toEqual(['timeSig1', 'timeSig2', 'timeSig8']);
    const top = digits.filter((g) => g.y === 1);
    const bottom = digits.filter((g) => g.y === 3);
    const centerOf = (gs: Glyph[]) => {
      const first = gs[0]!;
      const last = gs[gs.length - 1]!;
      return (first.x + last.x + STAFF_GLYPHS[last.glyph as StaffGlyphName].width) / 2;
    };
    expect(centerOf(top)).toBeCloseTo(centerOf(bottom), 6);
  });

  it('draws C and C| for common and cut time', () => {
    expect(timeGlyphs(lay('G4:1/1 |', { meter: 'C' })).map((g) => g.glyph)).toEqual([
      'timeSigCommon',
    ]);
    expect(timeGlyphs(lay('G4:1/2 |', { meter: 'C|' })).map((g) => g.glyph)).toEqual([
      'timeSigCutCommon',
    ]);
    expect(timeGlyphs(lay('G4:1/1 |', { meter: 'C' }))[0]!.y).toBe(2);
  });

  it('does not invent a time signature the file never gave (meter assumed to be 4/4)', () => {
    const assumed = layoutScore(build(FOUR_BARS, { meterAssumed: true }), {
      firstBar: 0,
      widthSpaces: 300,
    });
    expect(timeGlyphs(assumed)).toHaveLength(0);
    const forced = layoutScore(build(FOUR_BARS, { meterAssumed: true }), {
      firstBar: 0,
      widthSpaces: 300,
      showTimeSignature: true,
    });
    expect(timeGlyphs(forced)).toHaveLength(2);
    // A real meter change later in such a file is still drawn.
    const changed = layoutScore(
      build('C5:1/4 D5:1/4 E5:1/4 F5:1/4 | M:3/4 G5:1/4 A5:1/4 B5:1/4 |', { meterAssumed: true }),
      { firstBar: 0, widthSpaces: 300 },
    );
    expect(timeGlyphs(changed).map((g) => g.glyph)).toEqual(['timeSig3', 'timeSig4']);
  });

  it('shows the time signature at a window that starts where the meter changes', () => {
    const spec =
      'C5:1/4 D5:1/4 E5:1/4 F5:1/4 | M:3/4 G5:1/4 A5:1/4 B5:1/4 | C6:1/4 D6:1/4 E6:1/4 |';
    expect(timeGlyphs(lay(spec, undefined, { firstBar: 1 }))).toHaveLength(2);
    expect(timeGlyphs(lay(spec, undefined, { firstBar: 2 }))).toHaveLength(0);
    // And in a window that began earlier, the change is inline at its bar.
    const whole = lay(spec);
    const digits = timeGlyphs(whole);
    expect(digits).toHaveLength(4); // 4/4 at the start, 3/4 inline
    expect(digits[2]!.x).toBeGreaterThan(whole.barLines[0]!.x);
    expect(digits[2]!.glyph).toBe('timeSig3');
  });

  it('draws a key change inline at its bar, with naturals cancelling the old signs', () => {
    const l = lay('C5:1/4 D5:1/4 E5:1/4 F5:1/4 | K:0 G5:1/4 A5:1/4 B5:1/4 C6:1/4 |', { key: 2 });
    const all = keyGlyphs(l);
    expect(all.map((g) => g.glyph)).toEqual([
      'accidentalSharp',
      'accidentalSharp',
      'accidentalNatural',
      'accidentalNatural',
    ]);
    expect(all[2]!.x).toBeGreaterThan(l.barLines[0]!.x);
    // Inline signs come before the first note of their bar.
    const firstOfSecondBar = glyphs(l, 'head')[4]!;
    expect(all[3]!.x + STAFF_GLYPHS.accidentalNatural.width).toBeLessThan(firstOfSecondBar.x);
  });

  it('applies the new key to the accidentals after a change', () => {
    const l = lay('F#4:1/1 | K:0 F#4:1/1 |', { key: 1 });
    // G major first (no sign), then C major (sign needed).
    expect(glyphs(l, 'accidental').map((g) => g.noteIndex)).toEqual([1]);
  });

  it('does not show a key change that changes nothing', () => {
    const l = lay('C5:1/1 | K:2 D5:1/1 |', { key: 2 });
    expect(keyGlyphs(l)).toHaveLength(2); // only the opening signature
  });

  it('starts a window after a key change with the new key', () => {
    const l = lay('C5:1/1 | K:2 D5:1/1 | E5:1/1 |', undefined, { firstBar: 1 });
    expect(keyGlyphs(l)).toHaveLength(2);
  });
});

// --- tagging for highlighting ---------------------------------------------------------------------------------------

describe('layoutScore: note tagging', () => {
  const l = lay(
    'F#4:3/8 G3:1/8 ^A4:1/8 ^B4:1/8 z:1/4 | (3 C5:1/4 D5:1/4 E5:1/4 G4:1/2 | G4:5/8 G6:3/8 |',
  );

  it('tags every part of a note with its index', () => {
    const noteParts: ScorePart[] = [
      'head',
      'stem',
      'flag',
      'accidental',
      'dot',
      'ledger-line',
      'tie',
    ];
    const tagged = l.primitives.filter((p) => noteParts.includes(p.part));
    expect(tagged.length).toBeGreaterThan(10);
    for (const p of tagged) {
      expect(p.noteIndex).toBeGreaterThanOrEqual(0);
      expect(p.noteIndex).toBeLessThanOrEqual(9);
    }
  });

  it('tags nothing else', () => {
    const untagged: ScorePart[] = [
      'staff-line',
      'clef',
      'key-signature',
      'time-signature',
      'bar-line',
      'beam',
      'rest',
      'tuplet',
    ];
    for (const p of l.primitives.filter((q) => untagged.includes(q.part))) {
      expect(p.noteIndex).toBeUndefined();
    }
  });

  it('puts the parts of one note on the same row of its head', () => {
    for (const note of l.notes) {
      const head = glyphs(l, 'head').find((h) => h.noteIndex === note.noteIndex)!;
      expect(head.y).toBe(note.y);
      for (const sign of glyphs(l, 'accidental').filter((g) => g.noteIndex === note.noteIndex)) {
        expect(sign.y).toBe(note.y);
      }
    }
  });

  it('lists each shown note once, in note order, with the number of heads drawn', () => {
    const indexes = l.notes.map((n) => n.noteIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(l.notes.find((n) => n.noteIndex === 8)!.pieces).toBe(2); // G4:5/8 is a half and an eighth, tied
  });
});

// --- playhead mapping ---------------------------------------------------------------------------------------------

describe('layoutScore: xForWhole (playhead)', () => {
  const l = lay(FOUR_BARS, undefined, { widthSpaces: 300 });

  it('maps each note onset to the center of its notehead', () => {
    const starts = [0, 1 / 4, 1 / 2, 3 / 4, 1, 5 / 4];
    starts.forEach((whole, i) => {
      expect(l.xForWhole(whole)).toBeCloseTo(l.notes[i]!.xCenter, 6);
    });
  });

  it('uses the center of the head whatever its width (a whole note is wider than a quarter)', () => {
    const whole = lay('G4:1/1 | A4:1/1 |');
    expect(whole.xForWhole(0)).toBeCloseTo(whole.notes[0]!.xCenter, 9);
    expect(whole.xForWhole(1)).toBeCloseTo(whole.notes[1]!.xCenter, 9);
    expect(whole.notes[0]!.xCenter - whole.notes[0]!.x).toBeCloseTo(
      STAFF_GLYPHS.noteheadWhole.width / 2,
      9,
    );
  });

  it('never decreases as the position advances', () => {
    let previous = -Infinity;
    for (let whole = -0.5; whole <= 5; whole += 0.01) {
      const x = l.xForWhole(whole);
      expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = x;
    }
  });

  it('is clamped: the first note before the start, the end of the last bar after the end', () => {
    expect(l.xForWhole(-10)).toBe(l.notes[0]!.xCenter);
    const end = l.barLines[l.barLines.length - 1]!.x;
    expect(l.xForWhole(1000)).toBeCloseTo(end, 6);
    expect(l.xForWhole(Number.POSITIVE_INFINITY)).toBeCloseTo(end, 6);
    expect(l.xForWhole(Number.NEGATIVE_INFINITY)).toBe(l.notes[0]!.xCenter);
    expect(Number.isFinite(l.xForWhole(Number.NaN))).toBe(true);
  });

  it('interpolates between notes (a position halfway through a note is halfway to the next)', () => {
    const a = l.xForWhole(0);
    const b = l.xForWhole(1 / 4);
    expect(l.xForWhole(1 / 8)).toBeCloseTo((a + b) / 2, 6);
  });

  it('is clamped to the window: a later window starts at its first note', () => {
    const later = lay(FOUR_BARS, undefined, { firstBar: 2, widthSpaces: 300 });
    expect(later.xForWhole(0)).toBe(later.notes[0]!.xCenter);
    expect(later.xForWhole(2)).toBeCloseTo(later.notes[0]!.xCenter, 6);
  });

  it('moves monotonically across bar lines, tuplets and rests', () => {
    const rich = lay('G4:1/4 z:1/4 (3 A4:1/8 B4:1/8 C5:1/8 D5:1/4 | E5:1/2 z:1/2 | F5:1/1 |');
    let previous = -Infinity;
    for (let whole = 0; whole <= 3; whole += 0.005) {
      const x = rich.xForWhole(whole);
      expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = x;
    }
  });
});

describe('barIndexAtWhole', () => {
  const piece = build('D5:1/4 | G5:1/2 G5:1/4 A5:1/4 | B5:1/1 | C6:1/1 |]');

  it('finds the bar a position falls in', () => {
    expect(barIndexAtWhole(piece, 0)).toBe(0);
    expect(barIndexAtWhole(piece, 0.2)).toBe(0);
    expect(barIndexAtWhole(piece, 0.25)).toBe(1); // exactly at a bar line starts the next bar
    expect(barIndexAtWhole(piece, 1.2)).toBe(1);
    expect(barIndexAtWhole(piece, 1.25)).toBe(2);
    expect(barIndexAtWhole(piece, 2.5)).toBe(3);
  });

  it('clamps outside the piece', () => {
    expect(barIndexAtWhole(piece, -3)).toBe(0);
    expect(barIndexAtWhole(piece, 99)).toBe(3);
    expect(barIndexAtWhole(piece, Number.POSITIVE_INFINITY)).toBe(3);
    expect(barIndexAtWhole(piece, Number.NaN)).toBe(0);
  });

  it('tolerates floating-point noise at a bar line', () => {
    expect(barIndexAtWhole(piece, 0.25 - 1e-12)).toBe(1);
  });
});

describe('primitiveBounds', () => {
  it('bounds a line by its stroke, along and across', () => {
    const horizontal = primitiveBounds({
      kind: 'line',
      x1: 1,
      y1: 2,
      x2: 5,
      y2: 2,
      width: 0.2,
      part: 'staff-line',
    });
    expect(horizontal[0]).toBeCloseTo(1, 9);
    expect(horizontal[2]).toBeCloseTo(5, 9);
    expect(horizontal[1]).toBeCloseTo(1.9, 9);
    expect(horizontal[3]).toBeCloseTo(2.1, 9);
    const vertical = primitiveBounds({
      kind: 'line',
      x1: 3,
      y1: 0,
      x2: 3,
      y2: 4,
      width: 0.4,
      part: 'stem',
    });
    expect(vertical).toEqual([2.8, 0, 3.2, 4]);
  });

  it('places a glyph by its translation and bounds', () => {
    const [x1, y1, x2, y2] = STAFF_GLYPHS.noteheadBlack.bounds;
    expect(
      primitiveBounds({ kind: 'glyph', glyph: 'noteheadBlack', x: 10, y: 3, part: 'head' }),
    ).toEqual([10 + x1, 3 + y1, 10 + x2, 3 + y2]);
  });

  it('bounds polygons, circles and paths (stroked paths grow by half the width)', () => {
    expect(
      primitiveBounds({
        kind: 'polygon',
        points: [
          [1, 2],
          [4, 1],
          [4, 1.5],
          [1, 2.5],
        ],
        part: 'beam',
      }),
    ).toEqual([1, 1, 4, 2.5]);
    expect(primitiveBounds({ kind: 'circle', cx: 2, cy: 3, r: 0.5, part: 'bar-line' })).toEqual([
      1.5, 2.5, 2.5, 3.5,
    ]);
    const d = 'M1 2L3 2L3 1';
    expect(primitiveBounds({ kind: 'path', d, width: 0.2, filled: true, part: 'tie' })).toEqual([
      1, 1, 3, 2,
    ]);
    const stroked = primitiveBounds({ kind: 'path', d, width: 0.2, filled: false, part: 'tuplet' });
    expect(stroked[0]).toBeCloseTo(0.9, 9);
    expect(stroked[3]).toBeCloseTo(2.1, 9);
  });

  it('parses negative and decimal coordinates in path data', () => {
    expect(
      primitiveBounds({
        kind: 'path',
        d: 'M-1.5 0.25C-1 -2 2 -2 2.5 0.25Z',
        width: 0,
        filled: true,
        part: 'tie',
      }),
    ).toEqual([-1.5, -2, 2.5, 0.25]);
  });
});

// --- every primitive inside the view box ---------------------------------------------------------------------------------

describe('layoutScore: the view box contains everything drawn', () => {
  const SPECS: Record<string, [string, BuildPieceOptions?]> = {
    scale: [FOUR_BARS],
    extremes: ['G3:1/4 G6:1/4 C7:1/4 C3:1/4 | G3:1/1 |'],
    beamsLow: ['^G3:1/8 ^A3:1/8 ^B3:1/8 ^C4:1/8 ^D4:1/8 ^E4:1/8 ^F4:1/8 ^G4:1/8 |'],
    beamsHigh: ['^G6:1/16 ^F6:1/16 ^E6:1/16 ^D6:1/16 ^C6:1/16 ^B5:1/16 ^A5:1/16 ^G5:1/16 |'],
    bigLeaps: ['^G3:1/8 ^G6:1/8 ^G3:1/8 ^G6:1/8 | ^G6:1/32 ^G3:1/32 ^G6:1/32 ^G3:1/32 |'],
    tuplets: [
      '(3 G3:1/4 A3:1/4 B3:1/4 (3 G6:1/4 F6:1/4 E6:1/4 | (5/4 ^C5:1/16 ^D5:1/16 ^E5:1/16 ^F5:1/16 ^G5:1/16 |',
    ],
    tuplletsHigh: ['(3 C6:1/4 D6:1/4 E6:1/4 | (3 C7:1/8 D7:1/8 E7:1/8 |'],
    ties: ['G3:5/8 G3:3/8~ | G3:1/2 G6:5/8 G6:3/8~ | G6:1/1 |'],
    tiesDown: ['G6:1/2 G6:1/4 G6:1/4~ | G6:1/2 C7:1/2 |'],
    rests: ['z:1/1 | z:1/2 z:1/4 z:1/8 z:1/16 z:1/32 z:1/32 | x:1/1 |'],
    accidentals: ['F##3:1/16 Bbb3:1/16 C##6:1/16 Ebb6:1/16 F#4:1/16 G#4:1/16 A#4:1/16 B#4:1/16 |'],
    signatures: ['C5:1/1 | K:7 D5:1/1 | K:-7 E5:1/1 | M:12/8 K:0 F5:3/4 | M:C |', { key: 7 }],
    repeats: ['|: G4:1/1 :|: A4:1/1 || B4:1/1 :| C5:1/1 |]'],
    pickup: ['D5:1/4 | G5:1/2 G5:1/4 A5:1/4 | B5:1/1 |]'],
  };

  for (const [name, [spec, options]] of Object.entries(SPECS)) {
    it(`holds for "${name}" at every width and from every bar`, () => {
      const piece = build(spec, options);
      for (const widthSpaces of [8, 20, 40, 63, 120]) {
        for (let firstBar = 0; firstBar < Math.max(1, piece.barCount); firstBar += 1) {
          for (const justify of [false, true]) {
            const l = layoutScore(piece, { firstBar, widthSpaces, justify });
            expectInsideViewBox(l);
            expect(l.viewBox[2]).toBeGreaterThanOrEqual(widthSpaces - 1e-9);
          }
        }
      }
    });
  }
});

// --- sizing --------------------------------------------------------------------------------------------------------------

describe('sizeScore', () => {
  const piece = build(FOUR_BARS);

  it('aims at about 55 staff spaces across, within the unit limits, and fills the width', () => {
    const size = sizeScore(piece, { firstBar: 0, availableWidthPx: 1100 });
    expect(size.unitPx).toBeCloseTo(20, 6);
    expect(size.widthPx).toBeCloseTo(1100, 6);
    expect(size.heightPx).toBeCloseTo(size.layout.viewBox[3] * size.unitPx, 6);
    expect(size.layout.overflow).toBe(false);
  });

  it('clamps the unit to the limits (10 and 34 px by default)', () => {
    expect(sizeScore(piece, { firstBar: 0, availableWidthPx: 3000 }).unitPx).toBe(34);
    const small = sizeScore(piece, { firstBar: 0, availableWidthPx: 400 });
    expect(small.unitPx).toBeGreaterThanOrEqual(10 - 1e-9);
    const custom = sizeScore(piece, {
      firstBar: 0,
      availableWidthPx: 3000,
      maxUnitPx: 20,
    });
    expect(custom.unitPx).toBe(20);
  });

  it('fits the width on a phone: shrinks the unit so the first bar fits', () => {
    const size = sizeScore(piece, { firstBar: 0, availableWidthPx: 250 });
    expect(size.layout.overflow).toBe(false);
    expect(size.widthPx).toBeLessThanOrEqual(250 + 0.5);
    expect(size.unitPx).toBeLessThan(10);
    expect(size.unitPx).toBeGreaterThanOrEqual(6 - 1e-9);
  });

  it('accepts overflow rather than shrinking below about 6 px per space', () => {
    const dense = build(
      '^F#4:1/16 ^G#4:1/16 ^A#4:1/16 ^B#4:1/16 ^C#5:1/16 ^D#5:1/16 ^E#5:1/16 ^F#5:1/16 |',
      {
        key: 5,
      },
    );
    const size = sizeScore(dense, { firstBar: 0, availableWidthPx: 120 });
    expect(size.layout.overflow).toBe(true);
    expect(size.unitPx).toBeGreaterThanOrEqual(6 - 1e-9);
    expect(size.widthPx).toBeGreaterThan(120);
  });

  it('never makes the score taller than maxHeightPx', () => {
    for (const maxHeightPx of [60, 120, 200, 400]) {
      const size = sizeScore(piece, { firstBar: 0, availableWidthPx: 1100, maxHeightPx });
      expect(size.heightPx).toBeLessThanOrEqual(maxHeightPx + 0.5);
      expect(size.widthPx).toBeLessThanOrEqual(1100 + 0.5);
    }
  });

  it('passes showTimeSignature and firstBar through', () => {
    const size = sizeScore(piece, { firstBar: 2, availableWidthPx: 1100, showTimeSignature: true });
    expect(size.layout.firstBar).toBe(2);
    expect(glyphs(size.layout, 'time-signature').length).toBeGreaterThan(0);
  });

  it('survives silly input', () => {
    for (const availableWidthPx of [0, -5, Number.NaN, 1, 1e6]) {
      const size = sizeScore(piece, { firstBar: 0, availableWidthPx });
      expect(Number.isFinite(size.unitPx)).toBe(true);
      expect(size.unitPx).toBeGreaterThan(0);
      expect(Number.isFinite(size.widthPx + size.heightPx)).toBe(true);
    }
  });
});

// --- degenerate input ---------------------------------------------------------------------------------------------------------

describe('layoutScore: degenerate input never throws', () => {
  it('lays out an empty piece as just the staff', () => {
    const l = lay('');
    expect(l.notes).toEqual([]);
    expect(lines(l, 'staff-line')).toHaveLength(5);
    expect(l.lastBar).toBe(0);
    expectInsideViewBox(l);
    expect(Number.isFinite(l.xForWhole(1))).toBe(true);
  });

  it('lays out a piece with no elements at all', () => {
    const empty: AbcPiece = {
      ...build(''),
      elements: [],
      noteElements: [],
      notes: [],
      barCount: 0,
      barStartsWhole: [],
    };
    const l = layoutScore(empty, { firstBar: 3, widthSpaces: 50 });
    expect(l.firstBar).toBe(0);
    expectInsideViewBox(l);
  });

  it('draws a zero-length note as a 32nd', () => {
    const l = lay('G4:0/4 A4:1/4 |');
    expect(l.notes).toHaveLength(2);
    expectInsideViewBox(l);
  });

  it('draws a 1/256 note and a 16-whole-note note', () => {
    const tiny = lay('G4:1/256 A4:1/256 |');
    expect(tiny.notes).toHaveLength(2);
    expectInsideViewBox(tiny);
    const long = lay('G4:16/1 |');
    expect(long.notes[0]!.pieces).toBeGreaterThan(8); // a handful of the longest values, tied
    expect(paths(long, 'tie').length).toBe(long.notes[0]!.pieces - 1);
    expectInsideViewBox(long);
    const spanning = lay('G4:1/1~ | G4:1/1~ | G4:1/1~ | G4:1/1 | A4:1/1 |');
    expect(spanning.notes.find((n) => n.noteIndex === 0)!.pieces).toBe(4);
  });

  it('tolerates notes pointing at bars that do not exist', () => {
    const piece = build('G4:1/4 A4:1/4 | B4:1/4 |');
    const broken: AbcPiece = {
      ...piece,
      noteElements: piece.noteElements.map((e) => ({ ...e, bar: e.bar + 7 })),
      elements: piece.elements.map((e) => (e.type === 'note' ? { ...e, bar: e.bar + 7 } : e)),
    };
    for (const firstBar of [-1, 0, 1, 50]) {
      const l = layoutScore(broken, { firstBar, widthSpaces: 80 });
      expectInsideViewBox(l);
    }
  });

  it('tolerates non-finite numbers in the score', () => {
    const piece = build('G4:1/4 A4:1/4 B4:1/2 |');
    const noisy: AbcPiece = {
      ...piece,
      elements: piece.elements.map((e) =>
        e.type === 'note' && e.noteIndex === 1
          ? { ...e, start: Number.NaN, duration: Number.NaN, notated: Number.NaN }
          : e,
      ),
    };
    const l = layoutScore(noisy, { firstBar: 0, widthSpaces: 80 });
    expect(l.primitives.length).toBeGreaterThan(5);
    const infinite: AbcPiece = {
      ...piece,
      elements: piece.elements.map((e) =>
        e.type === 'note' && e.noteIndex === 1
          ? { ...e, duration: Number.POSITIVE_INFINITY, notated: Number.POSITIVE_INFINITY }
          : e,
      ),
    };
    expect(() => layoutScore(infinite, { firstBar: 0, widthSpaces: 80 })).not.toThrow();
  });

  it('tolerates silly widths: infinite means no limit, nonsense means no room', () => {
    const piece = build(FOUR_BARS);
    for (const widthSpaces of [
      0,
      -10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e9,
    ]) {
      const l = layoutScore(piece, { firstBar: 0, widthSpaces });
      expect(Number.isFinite(l.viewBox[2])).toBe(true);
      expect(l.lastBar).toBeGreaterThanOrEqual(0);
      expectInsideViewBox(l);
    }
    expect(layoutScore(piece, { firstBar: 0, widthSpaces: Number.POSITIVE_INFINITY }).lastBar).toBe(
      3,
    );
    expect(layoutScore(piece, { firstBar: 0, widthSpaces: 1e9 }).lastBar).toBe(3);
    expect(layoutScore(piece, { firstBar: 0, widthSpaces: Number.NaN }).lastBar).toBe(0);
    expect(layoutScore(piece, { firstBar: 0, widthSpaces: Number.NaN }).overflow).toBe(true);
  });

  it('tolerates a nonsense maxBars', () => {
    const piece = build(FOUR_BARS);
    for (const maxBars of [Number.NaN, -3, 0, 0.4, Number.POSITIVE_INFINITY]) {
      const l = layoutScore(piece, { firstBar: 0, widthSpaces: 300, maxBars });
      expect(l.lastBar).toBeGreaterThanOrEqual(0);
      expectInsideViewBox(l);
    }
  });

  it('tolerates a note with no spelling data and a note index out of range', () => {
    const piece = build('G4:1/4 A4:1/4 |');
    const stripped: AbcPiece = { ...piece, notes: [piece.notes[0]!] };
    const l = layoutScore(stripped, { firstBar: 0, widthSpaces: 80 });
    expect(l.notes.length).toBeGreaterThan(0);
    expectInsideViewBox(l);
  });
});

// --- real ABC ---------------------------------------------------------------------------------------------------------------------

function pieceFromAbc(text: string): AbcPiece {
  const tune = parseAbc(text).tunes[0]!;
  const result = buildAbcPracticeSequence(tune, {});
  if (result.status !== 'ok') throw new Error(`fixture not practicable: ${result.status}`);
  return result.piece;
}

describe('layoutScore: pieces from the real ABC parser', () => {
  const ODE = `X:1
T:Ode to Joy
M:4/4
L:1/4
Q:1/4=100
K:D
F F G A | A G F E | D D E F | F3/2 E/2 E2 |]
`;

  it('shows the key signature (two sharps) and 4/4, and draws no sign for in-key F-sharps', () => {
    const l = layoutScore(pieceFromAbc(ODE), { firstBar: 0, widthSpaces: 300 });
    expect(glyphs(l, 'key-signature').map((g) => g.glyph)).toEqual([
      'accidentalSharp',
      'accidentalSharp',
    ]);
    expect(glyphs(l, 'time-signature').map((g) => g.glyph)).toEqual(['timeSig4', 'timeSig4']);
    expect(glyphs(l, 'accidental')).toHaveLength(0);
    expect(l.notes).toHaveLength(15);
    expect(l.lastBar).toBe(3);
  });

  it('draws the dotted quarter and eighth of the last bar', () => {
    const l = layoutScore(pieceFromAbc(ODE), { firstBar: 3, widthSpaces: 300 });
    expect(glyphs(l, 'dot')).toHaveLength(1);
    expect(glyphs(l, 'flag').map((g) => g.glyph)).toHaveLength(1);
    expect(glyphs(l, 'head').map((g) => g.glyph)).toEqual([
      'noteheadBlack',
      'noteheadBlack',
      'noteheadHalf',
    ]);
  });

  it('beams what the file beams and flags what it does not', () => {
    const piece = pieceFromAbc(`X:1
T:t
M:4/4
L:1/8
K:C
CDEF G A B c | cBAG F E D C |]
`);
    const l = layoutScore(piece, { firstBar: 0, widthSpaces: 300 });
    // CDEF and cBAG are written together (one beam each); the other eight eighths stand alone with flags.
    expect(polygons(l, 'beam')).toHaveLength(2);
    expect(glyphs(l, 'flag')).toHaveLength(8);
  });

  it('draws a pickup bar, accidentals in the bar and a tied note that needs two heads', () => {
    const piece = pieceFromAbc(`X:1
T:t
M:4/4
L:1/8
K:G
D2 | G2 =F2 F2 F2 | F2- F3 z3 |]
`);
    expect(piece.pickupWhole).toBeGreaterThan(0);
    const l = layoutScore(piece, { firstBar: 0, widthSpaces: 300 });
    // In G major the F-sharps need no sign; the explicit natural does, and the F after it (still natural in that bar) does not.
    expect(glyphs(l, 'accidental').map((g) => [g.glyph, g.noteIndex])).toEqual([
      ['accidentalNatural', 2],
    ]);
    // F2- F3 is one note of 5/8: a half and an eighth joined by a tie.
    expect(l.notes.find((n) => n.noteIndex === 5)!.pieces).toBe(2);
    expect(paths(l, 'tie')).toHaveLength(1);
    expectInsideViewBox(l);
  });

  it('handles a triplet, a rest and a repeat', () => {
    const piece = pieceFromAbc(`X:1
T:t
M:4/4
L:1/8
K:C
|: (3CDE F2 z2 G2 | A4 B4 :|
`);
    const l = layoutScore(piece, { firstBar: 0, widthSpaces: 300 });
    expect(glyphs(l, 'tuplet')).toHaveLength(1);
    expect(glyphs(l, 'rest').length).toBeGreaterThan(0);
    expect(circles(l, 'bar-line').length).toBeGreaterThanOrEqual(4);
    expectInsideViewBox(l);
  });

  it('keeps each note index on its parts and the window consistent with the bar count', () => {
    const piece = pieceFromAbc(ODE);
    for (let firstBar = 0; firstBar < piece.barCount; firstBar += 1) {
      const l = layoutScore(piece, { firstBar, widthSpaces: 55 });
      expect(l.firstBar).toBe(firstBar);
      expect(l.lastBar).toBeGreaterThanOrEqual(firstBar);
      expect(l.lastBar).toBeLessThan(piece.barCount);
      const indexes = new Set(l.notes.map((n) => n.noteIndex));
      for (const head of glyphs(l, 'head')) expect(indexes.has(head.noteIndex!)).toBe(true);
      expectInsideViewBox(l);
    }
  });

  it('draws every bar of every example piece without leaving the view box', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = new URL('../../../../abc-music/', import.meta.url).pathname;
    let checked = 0;
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
      if (!entry.endsWith('.abc')) continue;
      // Every tune of the file, not only the first: monti-czardas.abc holds six.
      for (const parsed of parseAbc(readFileSync(join(dir, entry), 'utf8')).tunes) {
        const result = buildAbcPracticeSequence(parsed, {});
        if (result.status !== 'ok') continue;
        checked += 1;
        for (let firstBar = 0; firstBar < result.piece.barCount; firstBar += 1) {
          for (const widthSpaces of [30, 55]) {
            const l = layoutScore(result.piece, { firstBar, widthSpaces });
            expectInsideViewBox(l);
            // Nothing collides horizontally: each head (and its accidental) starts after the previous head ends.
            const heads = glyphs(l, 'head');
            const signs = glyphs(l, 'accidental');
            heads.forEach((head, i) => {
              if (i === 0) return;
              const previous = heads[i - 1]!;
              expect(head.x).toBeGreaterThanOrEqual(
                previous.x + STAFF_GLYPHS[previous.glyph].width - 1e-9,
              );
              for (const sign of signs.filter((s) => s.noteIndex === head.noteIndex)) {
                expect(sign.x).toBeGreaterThanOrEqual(
                  previous.x + STAFF_GLYPHS[previous.glyph].width - 1e-9,
                );
              }
            });
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
