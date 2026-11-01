import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import { describeFinger, fingerMarkFor, fingerMarksOf, suggestFinger } from './fingering.js';
import { layoutScore } from './score-layout.js';

function tune(body: string, key = 'C') {
  return parseAbc(`X:1\nT:T\nM:4/4\nL:1/4\nK:${key}\n${body}\n`).tunes[0]!;
}

function practice(body: string, key = 'C', options = {}) {
  const result = buildAbcPracticeSequence(tune(body, key), options);
  if (result.status !== 'ok') throw new Error(result.status);
  return result;
}

describe('suggestFinger (first position)', () => {
  it('gives 0 for every open string', () => {
    expect([55, 62, 69, 76].map(suggestFinger)).toEqual([0, 0, 0, 0]);
  });

  it('walks D major on the A string: 0 1 2 3 then the open E', () => {
    // A4 B4 C#5 D5 E5
    expect([69, 71, 73, 74, 76].map(suggestFinger)).toEqual([0, 1, 2, 3, 0]);
  });

  it('puts both placements of a finger on the same number', () => {
    // On the D string: E4 (high 1) / D#4 (low 1) -> 1, F4/F#4 -> 2, G4/G#4 -> 3, A4 is the open A.
    expect([63, 64, 65, 66, 67, 68, 69].map(suggestFinger)).toEqual([1, 1, 2, 2, 3, 3, 0]);
  });

  it('uses the fourth finger only where there is no higher open string', () => {
    expect(suggestFinger(83)).toBe(4); // B5 on the E string
    expect(suggestFinger(76 + 7)).toBe(4);
  });

  it('prefers the higher string (D5 is the third finger on A, not a long stretch on D)', () => {
    expect(suggestFinger(74)).toBe(3);
    expect(suggestFinger(67)).toBe(3); // G4 on D
  });

  it('suggests nothing above the first position, or for junk', () => {
    expect(suggestFinger(84)).toBeUndefined(); // C6
    expect(suggestFinger(96)).toBeUndefined();
    expect(suggestFinger(54)).toBeUndefined(); // below the open G
    expect(suggestFinger(Number.NaN)).toBeUndefined();
  });
});

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
  it('prefers the file`s number and marks where each came from', () => {
    const { notes } = practice('!2!A, B, C D');
    const marks = fingerMarksOf(notes);
    // A3 is 2 semitones above the open G string: the file says 2, the suggestion would be 1.
    expect(marks[0]).toEqual({ finger: 2, source: 'file' });
    expect(marks[1]).toEqual({ finger: 2, source: 'suggested' }); // B3, 4 semitones above G
    expect(marks[3]).toEqual({ finger: 0, source: 'suggested' }); // D4 is the open string
  });

  it('shows an open string written as !0!', () => {
    expect(fingerMarkFor(practice('!0!D').notes[0]!)).toEqual({ finger: 0, source: 'file' });
  });

  it('drops the file`s numbers (and suggests instead) after a transposition', () => {
    const { notes } = practice('!4!A', 'C', { transposeSemitones: 12 });
    expect(notes[0]!.finger).toBeUndefined();
  });

  it('has no mark for a note above first position and no suggestion', () => {
    expect(fingerMarkFor(practice("c'").notes[0]!)).toBeUndefined(); // C6
  });

  it('describes them', () => {
    expect(describeFinger({ finger: 0, source: 'file' })).toBe('Open string');
    expect(describeFinger({ finger: 3, source: 'suggested' })).toBe('Finger 3');
    expect(describeFinger(undefined)).toBe('');
  });
});

describe('finger numbers on the score', () => {
  const body = 'A, B, C D | E F G A |]';
  const result = practice(body);
  const piece = result.piece;

  it('draws one digit per note, above the staff, only when asked', () => {
    const plain = layoutScore(piece, { firstBar: 0, widthSpaces: 60 });
    expect(plain.primitives.some((p) => p.part === 'finger' || p.part === 'finger-suggested')).toBe(
      false,
    );
    const layout = layoutScore(piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: fingerMarksOf(result.notes),
    });
    const digits = layout.primitives.filter(
      (p) => p.part === 'finger' || p.part === 'finger-suggested',
    );
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

  it('tags file numbers and suggestions differently, and skips notes without a mark', () => {
    const r = practice("!1!A, B, c' D");
    const layout = layoutScore(r.piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: fingerMarksOf(r.notes),
    });
    const parts = new Map(
      layout.primitives
        .filter((p) => p.part === 'finger' || p.part === 'finger-suggested')
        .map((p) => [p.noteIndex, p.part]),
    );
    expect(parts.get(0)).toBe('finger');
    expect(parts.get(1)).toBe('finger-suggested');
    expect(parts.has(2)).toBe(false); // C6: no suggestion
    expect(parts.get(3)).toBe('finger-suggested');
  });

  it('keeps a high note`s digit above its stem and inside the view box', () => {
    const r = practice("a b c' d'");
    const layout = layoutScore(r.piece, {
      firstBar: 0,
      widthSpaces: 60,
      fingers: [
        { finger: 1, source: 'file' },
        { finger: 2, source: 'file' },
        { finger: 3, source: 'file' },
        { finger: 4, source: 'file' },
      ],
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
