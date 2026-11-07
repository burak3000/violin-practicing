import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import { describeFinger, fingerMarkFor, fingerMarksOf } from './fingering.js';
import { layoutScore } from './score-layout.js';

function tune(body: string, key = 'C') {
  return parseAbc(`X:1\nT:T\nM:4/4\nL:1/4\nK:${key}\n${body}\n`).tunes[0]!;
}

function practice(body: string, key = 'C', options = {}) {
  const result = buildAbcPracticeSequence(tune(body, key), options);
  if (result.status !== 'ok') throw new Error(result.status);
  return result;
}

describe('finger numbers in the ABC file', () => {
  it('reads !0! to !4! before a note', () => {
    const voice = tune('!0!G, !1!A, !2!B, !3!C !4!D E').voices[0]!;
    expect(voice.fingers).toEqual([0, 1, 2, 3, 4, undefined]);
  });

  it('also reads the old +1+ style, and ignores other decorations', () => {
    const voice = tune('+2+A !trill!B !fermata!!3!C').voices[0]!;
    expect(voice.fingers).toEqual([2, undefined, 3]);
  });

  it('ignores digits that are not fingers (!5!, !12!)', () => {
    const voice = tune('!5!A !12!B').voices[0]!;
    expect(voice.fingers).toEqual([undefined, undefined]);
  });

  it('keeps the first part of a tied note and drops a number on the tied part', () => {
    const voice = tune('!1!A- !2!A B').voices[0]!;
    expect(voice.notes).toHaveLength(2);
    expect(voice.fingers).toEqual([1, undefined]);
  });

  it('attaches a chord member`s number to the top note, or an outer one when the member has none', () => {
    expect(tune('[!1!C !2!E] !3![CG]').voices[0]!.fingers).toEqual([2, 3]);
  });

  it('does not let a number before a rest leak onto the next note', () => {
    expect(tune('!1!z A').voices[0]!.fingers).toEqual([undefined]);
  });

  it('keeps fingers parallel to notes through bars, grace notes and rests', () => {
    const voice = tune('!1!A {g}!2!B | z !3!C |]').voices[0]!;
    expect(voice.fingers).toEqual([1, 2, 3]);
  });
});

describe('fingerMarkFor / fingerMarksOf / describeFinger', () => {
  it('shows the file`s number and nothing for a note it leaves unmarked', () => {
    const marks = fingerMarksOf(practice('!2!A, B, C D').notes);
    expect(marks[0]).toEqual({ finger: 2 });
    expect(marks[1]).toBeUndefined();
    expect(marks[2]).toBeUndefined();
    expect(marks[3]).toBeUndefined(); // D4 is an open-string pitch, but the file does not say so
  });

  it('shows an open string written as !0!', () => {
    expect(fingerMarkFor(practice('!0!D').notes[0]!)).toEqual({ finger: 0 });
  });

  it('keeps a number written for another position, whatever the pitch', () => {
    // E5 played with the first finger (a shift) and A4 with the fourth on the D string.
    const marks = fingerMarksOf(practice('!1!e !4!A').notes);
    expect(marks).toEqual([{ finger: 1 }, { finger: 4 }]);
    expect(fingerMarkFor(practice("!2!c'").notes[0]!)).toEqual({ finger: 2 }); // C6
  });

  it('shows nothing after a transposition (the file wrote them for the sheet`s own strings)', () => {
    const { notes } = practice('!4!A', 'C', { transposeSemitones: 12 });
    expect(notes[0]!.finger).toBeUndefined();
    expect(fingerMarkFor(notes[0]!)).toBeUndefined();
  });

  it('describes them', () => {
    expect(describeFinger({ finger: 0 })).toBe('Open string');
    expect(describeFinger({ finger: 3 })).toBe('Finger 3');
    expect(describeFinger(undefined)).toBe('');
  });
});

describe('finger numbers on the score', () => {
  const body = '!1!A, !2!B, !3!C !0!D | !1!E !2!F !3!G !0!A |]';
  const result = practice(body);
  const piece = result.piece;

  it('draws one digit per note, above the staff, only when asked', () => {
    const plain = layoutScore(piece, { firstBar: 0, widthSpaces: 60 });
    expect(plain.primitives.some((p) => p.part === 'finger')).toBe(false);
    const layout = layoutScore(piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: fingerMarksOf(result.notes),
    });
    const digits = layout.primitives.filter((p) => p.part === 'finger');
    expect(digits).toHaveLength(result.notes.length);
    for (const d of digits) {
      expect(d.kind).toBe('glyph');
      expect(d.noteIndex).toBeDefined();
    }
  });

  it('does not change the spacing or the note positions', () => {
    const plain = layoutScore(piece, { firstBar: 0, widthSpaces: 60 });
    const withFingers = layoutScore(piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: fingerMarksOf(result.notes),
    });
    expect(withFingers.notes).toEqual(plain.notes);
    expect(withFingers.widthSpaces).toBe(plain.widthSpaces);
  });

  it('draws digits only over the notes the file marks', () => {
    const r = practice("!1!A, B, c' !0!D");
    const layout = layoutScore(r.piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: fingerMarksOf(r.notes),
    });
    const marked = layout.primitives.filter((p) => p.part === 'finger').map((p) => p.noteIndex);
    expect(marked).toEqual([0, 3]);
  });

  it('keeps a high note`s digit above its stem and inside the view box', () => {
    const r = practice("a b c' d'");
    const layout = layoutScore(r.piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: [{ finger: 1 }, { finger: 2 }, { finger: 3 }, { finger: 4 }],
    });
    const [, minY, , height] = layout.viewBox;
    const heads = layout.primitives.filter((p) => p.part === 'head');
    for (const d of layout.primitives.filter((p) => p.part === 'finger')) {
      if (d.kind !== 'glyph') continue;
      const head = heads.find((h) => h.noteIndex === d.noteIndex)!;
      expect(d.y).toBeLessThan((head as { y: number }).y);
      expect(d.y).toBeGreaterThan(minY);
      expect(d.y).toBeLessThan(minY + height);
    }
  });
});
