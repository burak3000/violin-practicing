import { describe, expect, it } from 'vitest';
import { MAX_ABC_TEXT_LENGTH, parseAbc } from './abc-parser.js';

/**
 * Expected MIDI numbers below are worked out from the ABC rules directly
 * (C = C4 = 60, c = C5 = 72, ABC's `K:` circle-of-fifths table, accidentals
 * lasting to the bar line), not copied from the parser's own output.
 */

/** Wraps a music body in a minimal valid tune and returns the first voice's notes. */
function notes(body: string, key = 'C'): readonly number[] {
  const result = parseAbc(`X:1\nT:Test\nK:${key}\n${body}\n`);
  return result.tunes[0]!.voices[0]!.notes;
}

function warnings(body: string, key = 'C'): readonly string[] {
  return parseAbc(`X:1\nT:Test\nK:${key}\n${body}\n`).tunes[0]!.warnings;
}

describe('parseAbc: pitches, octaves and accidentals', () => {
  it('reads a plain C major scale (uppercase = octave 4, lowercase = octave 5)', () => {
    expect(notes('CDEF GABc|')).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it("applies octave marks: , lowers and ' raises", () => {
    expect(notes("C,, C, C c c' c''")).toEqual([36, 48, 60, 72, 84, 96]);
  });

  it('reads sharps, flats, naturals and doubles', () => {
    expect(notes('^C _B =F ^^C __B')).toEqual([61, 70, 65, 62, 69]);
  });

  it('keeps an accidental in force for the rest of the bar, then drops it at the bar line', () => {
    expect(notes('F ^F F | F')).toEqual([65, 66, 66, 65]);
  });

  it('scopes an accidental to its own octave: ^F does not sharpen f', () => {
    expect(notes('^F f')).toEqual([66, 77]);
  });

  it('lets a natural override the key signature for the rest of the bar', () => {
    expect(notes('=F F | F', 'G')).toEqual([65, 65, 66]);
  });

  it('treats a bar line variety (|| |] [| |: :| ::) as a bar boundary', () => {
    for (const bar of ['||', '|]', '[|', '|:', ':|', '::', ':|:']) {
      expect(notes(`^F ${bar} F`)).toEqual([66, 65]);
    }
  });
});

describe('parseAbc: key signatures', () => {
  // [key field, body, expected MIDI]
  const cases: ReadonlyArray<readonly [string, string, readonly number[]]> = [
    ['C', 'F C G', [65, 60, 67]],
    ['G', 'F C', [66, 60]],
    ['D', 'F C G', [66, 61, 67]],
    ['Bm', 'F C', [66, 61]],
    ['Em', 'F C D', [66, 60, 62]],
    ['F#m', 'F C G', [66, 61, 68]],
    ['C#m', 'F C G D A', [66, 61, 68, 63, 69]],
    ['Bb', 'B E A', [70, 63, 69]],
    ['Eb', 'B E A D', [70, 63, 68, 62]],
    ['Gm', 'B E A', [70, 63, 69]],
    ['Cm', 'B E A', [70, 63, 68]],
    ['A minor', 'F G', [65, 67]],
    ['Am', 'F G', [65, 67]],
    ['G Major', 'F', [66]],
    ['Edor', 'F C G D', [66, 61, 67, 62]],
    ['Ador', 'F C', [66, 60]],
    ['Amix', 'F C G', [66, 61, 67]],
    ['Gmix', 'F', [65]],
    ['Dmix', 'F C', [66, 60]],
    ['F lydian', 'B', [71]],
    ['Dloc', 'B E A', [70, 63, 68]],
    ['Dphr', 'B', [70]],
    ['HP', 'F C G', [66, 61, 67]],
    ['Hp', 'F C G', [66, 61, 67]],
    ['none', 'F C', [65, 60]],
    ['G clef=bass', 'F', [66]],
    ['D =c', 'F C', [66, 60]],
    ['D exp _b _e', 'B E F', [70, 63, 65]],
    ['C ^f', 'F', [66]],
  ];

  it.each(cases)('K:%s reads %s correctly', (key, body, expected) => {
    expect(notes(body, key)).toEqual(expected);
  });

  it('reads letters through double sharps for a key past seven sharps (G# major: F##)', () => {
    expect(notes('F G', 'G#')).toEqual([67, 68]);
  });

  it('applies a mid-tune K: line from that point on', () => {
    expect(notes('F |\nK:G\nF')).toEqual([65, 66]);
  });

  it('applies an inline [K:...] field from that point on', () => {
    expect(notes('F [K:G] F | F')).toEqual([65, 66, 66]);
  });

  it('warns on an unknown mode and falls back to major', () => {
    const w = warnings('F', 'Gzzz');
    expect(w.some((m) => m.includes('Unknown mode'))).toBe(true);
    expect(notes('F', 'Gzzz')).toEqual([66]);
  });
});

describe('parseAbc: ties, rests and note shapes', () => {
  it('merges tied notes into one note to play (also across a bar line)', () => {
    expect(notes('C2-C2 D')).toEqual([60, 62]);
    expect(notes('C-|C D')).toEqual([60, 62]);
    expect(notes('C- C- C D')).toEqual([60, 62]);
  });

  it('carries an accidental through a tie into the next bar', () => {
    expect(notes('^C-|C D')).toEqual([61, 62]);
  });

  it('keeps both notes and warns when a tie joins two different pitches', () => {
    expect(notes('C-D')).toEqual([60, 62]);
    expect(warnings('C-D').some((m) => m.includes('tie'))).toBe(true);
  });

  it('does not tie across a rest', () => {
    expect(notes('C- z C')).toEqual([60, 60]);
  });

  it('drops rests of every kind', () => {
    expect(notes('C z D Z2 E x F y')).toEqual([60, 62, 64, 65]);
  });

  it('ignores lengths, broken rhythm and tuplet markers', () => {
    expect(notes('C2 D/2 E3/2 F// G>A B<c')).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(notes('(3CDE F')).toEqual([60, 62, 64, 65]);
    expect(notes('(3:2:3CDE F')).toEqual([60, 62, 64, 65]);
  });

  it('ignores slurs', () => {
    expect(notes('(CD) (E F)')).toEqual([60, 62, 64, 65]);
  });

  it('skips grace notes, decorations, annotations and chord symbols', () => {
    expect(notes('{g}A {/B}c')).toEqual([69, 72]);
    expect(notes('"Am"!trill!~A.B uC Hd')).toEqual([69, 71, 60, 74]);
    expect(notes('+trill+C')).toEqual([60]);
  });

  it('skips lyric, comment and directive lines', () => {
    expect(notes('% a comment\n%%MIDI program 40\nC D\nw: la la\nE F')).toEqual([60, 62, 64, 65]);
  });

  it('stops reading a line at a trailing comment', () => {
    expect(notes('C % D E\nF')).toEqual([60, 65]);
  });

  it('joins a line continued with a backslash', () => {
    expect(notes('C D \\\nE F')).toEqual([60, 62, 64, 65]);
  });

  it('ignores inline meter/length fields', () => {
    expect(notes('[M:3/4] [L:1/16] C D')).toEqual([60, 62]);
  });
});

describe('parseAbc: repeats and endings are read as written, not expanded', () => {
  it('reads |: :| and numbered endings without turning them into notes', () => {
    expect(notes('|: C D :|1 E :|2 F |]')).toEqual([60, 62, 64, 65]);
    expect(notes('|:C D [1 E :|[2 F|]')).toEqual([60, 62, 64, 65]);
    expect(notes('C |1 D :|2 E')).toEqual([60, 62, 64]);
  });
});

describe('parseAbc: things it cannot represent are reported, never silently mis-parsed', () => {
  it('reduces a chord / double stop to its top note and says so', () => {
    expect(notes('[CEG] [FA]')).toEqual([67, 69]);
    expect(warnings('[CEG] [FA]').some((m) => m.includes('2 chords/double-stops'))).toBe(true);
  });

  it('does not warn about a one-note "chord"', () => {
    expect(notes('[C] [CC]')).toEqual([60, 60]);
    expect(warnings('[C] [CC]')).toEqual([]);
  });

  it('applies accidentals written inside a chord to the rest of the bar', () => {
    expect(notes('[^FA] F')).toEqual([69, 66]);
  });

  it('treats a microtonal accidental as the plain sign and warns', () => {
    expect(notes('^/C')).toEqual([61]);
    expect(warnings('^/C').some((m) => m.includes('Microtonal'))).toBe(true);
  });

  it('skips voice-overlay (&) notes until the bar line and warns', () => {
    expect(notes('C D & E F | G')).toEqual([60, 62, 67]);
    expect(warnings('C D & E F | G').some((m) => m.includes('overlay'))).toBe(true);
  });

  it('warns when a macro is declared', () => {
    const result = parseAbc('X:1\nm: ~G3 = G{A}G{F}G\nK:C\nC\n');
    expect(result.tunes[0]!.warnings.some((m) => m.includes('Macros'))).toBe(true);
  });

  it('warns about characters it does not understand and still reads the notes around them', () => {
    expect(notes('C ? D')).toEqual([60, 62]);
    expect(warnings('C ? D').some((m) => m.includes('"?"'))).toBe(true);
  });

  it('warns about an unterminated chord and skips the rest of that line', () => {
    expect(notes('C [EG\nD')).toEqual([60, 62]);
    expect(warnings('C [EG\nD').some((m) => m.includes('closing bracket'))).toBe(true);
  });

  it('warns when the tune has no K: line, and still reads the music', () => {
    const result = parseAbc('X:1\nT:No key\nCDE\n');
    expect(result.tunes[0]!.voices[0]!.notes).toEqual([60, 62, 64]);
    expect(result.tunes[0]!.warnings.some((m) => m.includes('no K:'))).toBe(true);
  });
});

describe('parseAbc: header fields and file structure', () => {
  it('reads reference number, title, composer and key', () => {
    const tune = parseAbc('X:7\nT:The Tune\nT:A subtitle\nC:Trad.\nM:4/4\nL:1/8\nK:Dmix\nD\n')
      .tunes[0]!;
    expect(tune.referenceNumber).toBe('7');
    expect(tune.title).toBe('The Tune');
    expect(tune.composer).toBe('Trad.');
    expect(tune.key).toBe('Dmix');
  });

  it('splits a multi-tune file at X: lines and blank lines', () => {
    const result = parseAbc(
      [
        'X:1',
        'T:One',
        'K:C',
        'CDE|',
        '',
        'X:2',
        'T:Two',
        'K:G',
        'F|',
        '',
        'X:3',
        'T:Three',
        'K:C',
        'G|',
      ].join('\n'),
    );
    expect(result.tunes.map((t) => t.title)).toEqual(['One', 'Two', 'Three']);
    expect(result.tunes.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(result.tunes[1]!.voices[0]!.notes).toEqual([66]);
  });

  it('starts a new tune at X: even without a separating blank line', () => {
    const result = parseAbc('X:1\nK:C\nC\nX:2\nK:C\nD\n');
    expect(result.tunes.map((t) => t.voices[0]!.notes[0])).toEqual([60, 62]);
  });

  it('accepts a tune with no X: line', () => {
    const result = parseAbc('T:Loose\nK:G\nFG\n');
    expect(result.tunes).toHaveLength(1);
    expect(result.tunes[0]!.voices[0]!.notes).toEqual([66, 67]);
  });

  it('ignores a file header before the first tune', () => {
    const result = parseAbc('%abc-2.1\nI:linebreak $\n\nX:1\nK:C\nC\n');
    expect(result.tunes).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('handles CRLF and CR line endings and a byte-order mark', () => {
    expect(parseAbc('﻿X:1\r\nK:C\r\nC D\r\nE\r\n').tunes[0]!.voices[0]!.notes).toEqual([
      60, 62, 64,
    ]);
    expect(parseAbc('X:1\rK:C\rC D\r').tunes[0]!.voices[0]!.notes).toEqual([60, 62]);
  });

  it('warns about music after a blank line instead of dropping it silently', () => {
    const result = parseAbc('X:1\nT:Split\nK:C\n\nCDEF|\n');
    expect(result.warnings.some((m) => m.includes('blank line'))).toBe(true);
    expect(result.tunes[0]!.voices[0]!.notes).toEqual([]);
  });

  it('reports "no tune found" for empty input and for text that is not ABC', () => {
    for (const text of ['', '   \n\n', 'hello world', 'lorem ipsum\ndolor sit amet']) {
      const result = parseAbc(text);
      expect(result.tunes).toEqual([]);
      expect(result.warnings[0]).toContain('No ABC tune');
    }
  });

  it('refuses a file over the size cap without parsing it', () => {
    const result = parseAbc('X:1\nK:C\n' + 'C'.repeat(MAX_ABC_TEXT_LENGTH));
    expect(result.tunes).toEqual([]);
    expect(result.warnings.some((m) => m.includes('too large'))).toBe(true);
  });

  it('returns a tune with no notes (rather than dropping it) when the body is empty', () => {
    const result = parseAbc('X:1\nT:Empty\nK:C\n');
    expect(result.tunes).toHaveLength(1);
    expect(result.tunes[0]!.voices[0]!.notes).toEqual([]);
  });
});

describe('parseAbc: voices', () => {
  const duet = [
    'X:1',
    'T:Duet',
    'V:1 name="Violin"',
    'V:2 name="Cello"',
    'K:C',
    '[V:1] C D E F |',
    '[V:2] C, D, E, F, |',
    'V:1',
    'G A |',
  ].join('\n');

  it('keeps each voice separate, in order of first mention', () => {
    const tune = parseAbc(duet).tunes[0]!;
    expect(tune.voices.map((v) => v.id)).toEqual(['1', '2']);
    expect(tune.voices[0]!.name).toBe('Violin');
    expect(tune.voices[0]!.notes).toEqual([60, 62, 64, 65, 67, 69]);
    expect(tune.voices[1]!.notes).toEqual([48, 50, 52, 53]);
  });

  it('warns that only the first voice is used by default', () => {
    expect(parseAbc(duet).tunes[0]!.warnings.some((m) => m.includes('2 voices'))).toBe(true);
  });

  it('puts music that precedes any V: line in the first declared voice', () => {
    const tune = parseAbc('X:1\nV:T1\nV:T2\nK:C\nC D\nV:T2\nE\n').tunes[0]!;
    expect(tune.voices.map((v) => v.id)).toEqual(['T1', 'T2']);
    expect(tune.voices[0]!.notes).toEqual([60, 62]);
  });

  it('keeps accidental scope per voice, even within one bar', () => {
    const tune = parseAbc('X:1\nK:C\n[V:1] ^F [V:2] F [V:1] F |\n').tunes[0]!;
    // Voice 2's plain F is unaffected by voice 1's sharp; voice 1's own sharp still holds.
    expect(tune.voices.find((v) => v.id === '2')!.notes).toEqual([65]);
    expect(tune.voices.find((v) => v.id === '1')!.notes).toEqual([66, 66]);
  });

  it('gives a plain tune a single default voice', () => {
    const tune = parseAbc('X:1\nK:C\nC\n').tunes[0]!;
    expect(tune.voices).toHaveLength(1);
    expect(tune.voices[0]!.id).toBe('');
  });
});

describe('parseAbc: written spellings (for drawing the notes on a staff)', () => {
  function spellings(body: string, key = 'C') {
    return parseAbc(`X:1\nK:${key}\n${body}\n`).tunes[0]!.voices[0]!.spellings;
  }

  it('keeps flats as flats and sharps as sharps, parallel to the MIDI notes', () => {
    const tune = parseAbc('X:1\nK:Bb\nB E A\n').tunes[0]!;
    expect(tune.voices[0]!.spellings).toEqual([
      { letter: 'B', accidental: -1, octave: 4 },
      { letter: 'E', accidental: -1, octave: 4 },
      { letter: 'A', accidental: 0, octave: 4 },
    ]);
    expect(tune.voices[0]!.spellings).toHaveLength(tune.voices[0]!.notes.length);
  });

  it('reads accidentals, octave marks and case into the spelling', () => {
    expect(spellings("^F _B =c C, c'")).toEqual([
      { letter: 'F', accidental: 1, octave: 4 },
      { letter: 'B', accidental: -1, octave: 4 },
      { letter: 'C', accidental: 0, octave: 5 },
      { letter: 'C', accidental: 0, octave: 3 },
      { letter: 'C', accidental: 0, octave: 6 },
    ]);
  });

  it('applies the key signature and double accidentals to the spelling', () => {
    expect(spellings('F ^^C __B', 'D')).toEqual([
      { letter: 'F', accidental: 1, octave: 4 },
      { letter: 'C', accidental: 2, octave: 4 },
      { letter: 'B', accidental: -2, octave: 4 },
    ]);
  });

  it('keeps one spelling per played note across ties, rests and chords', () => {
    const tune = parseAbc('X:1\nK:C\n_B- B z [CEG] D\n').tunes[0]!;
    const voice = tune.voices[0]!;
    expect(voice.notes).toEqual([70, 67, 62]);
    expect(voice.spellings).toEqual([
      { letter: 'B', accidental: -1, octave: 4 },
      { letter: 'G', accidental: 0, octave: 4 },
      { letter: 'D', accidental: 0, octave: 4 },
    ]);
  });

  it('keeps spellings separate per voice', () => {
    const tune = parseAbc('X:1\nK:C\n[V:1] _B |\n[V:2] ^F |\n').tunes[0]!;
    expect(tune.voices.find((v) => v.id === '1')!.spellings[0]).toEqual({
      letter: 'B',
      accidental: -1,
      octave: 4,
    });
    expect(tune.voices.find((v) => v.id === '2')!.spellings[0]).toEqual({
      letter: 'F',
      accidental: 1,
      octave: 4,
    });
  });
});
