import { describe, expect, it } from 'vitest';
import {
  computeDisplayAccidentals,
  displayedKeyOffsets,
  keySignatureGlyphs,
} from './score-accidentals.js';
import { NO_KEY_OFFSETS, type KeyOffsets } from '../abc/abc-score.js';
import { buildPiece, keyOffsetsForFifths } from './test-support/piece-builder.js';

/** Accidentals as a plain object keyed by note index, for readable expectations. */
function accidentalsOf(
  spec: string,
  options?: Parameters<typeof buildPiece>[1],
): Record<number, number> {
  return Object.fromEntries(computeDisplayAccidentals(buildPiece(spec, options)));
}

describe('computeDisplayAccidentals: the key signature sets the default', () => {
  it('draws nothing for F-sharp in G major, in any octave', () => {
    expect(accidentalsOf('F#4:1/4 F#5:1/4 F#3:1/4', { key: 1 })).toEqual({});
  });

  it('draws a natural for F-natural in G major', () => {
    expect(accidentalsOf('F4:1/4', { key: 1 })).toEqual({ 0: 0 });
  });

  it('draws nothing for B-flat in F major and a natural for B-natural', () => {
    expect(accidentalsOf('Bb4:1/4', { key: -1 })).toEqual({});
    expect(accidentalsOf('B4:1/4', { key: -1 })).toEqual({ 0: 0 });
  });

  it('draws a sharp for F-sharp in C major (no signature)', () => {
    expect(accidentalsOf('F#4:1/4', { key: 0 })).toEqual({ 0: 1 });
  });

  it('draws nothing for plain naturals in C major', () => {
    expect(accidentalsOf('C4:1/4 D4:1/4 E4:1/4 F4:1/4 G4:1/4 A4:1/4 B4:1/4', { key: 0 })).toEqual(
      {},
    );
  });

  it('draws double accidentals as written when the key does not carry them', () => {
    expect(accidentalsOf('F##4:1/4 Bbb4:1/4')).toEqual({ 0: 2, 1: -2 });
  });

  it('draws a plain sharp for F-sharp in a key where F is double sharp (not drawable in a signature)', () => {
    // G-sharp major's F## cannot be printed in a signature, so F is "natural" as displayed and the note carries its own sign.
    const offsets: KeyOffsets = { ...NO_KEY_OFFSETS, F: 2 };
    expect(accidentalsOf('F##4:1/4 F#4:1/4 F4:1/4', { key: offsets })).toEqual({
      0: 2,
      1: 1,
      2: 0,
    });
  });
});

describe('computeDisplayAccidentals: an accidental holds for the rest of its bar, for that pitch only', () => {
  it('draws the sign once for a repeated F-sharp in C major', () => {
    expect(accidentalsOf('F#4:1/4 F#4:1/4 F#4:1/4 F#4:1/4')).toEqual({ 0: 1 });
  });

  it('draws the sign again after the bar line (the accidental expired)', () => {
    expect(
      accidentalsOf('F#4:1/4 F#4:1/4 F#4:1/4 F#4:1/4 | F#4:1/4 F#4:1/4 F#4:1/4 F#4:1/4 |'),
    ).toEqual({
      0: 1,
      4: 1,
    });
  });

  it('draws nothing for a plain F in the bar after F-sharp in C major (back to the signature)', () => {
    expect(accidentalsOf('F#4:1/4 G4:1/4 G4:1/4 G4:1/4 | F4:1/4 G4:1/4 G4:1/4 G4:1/4 |')).toEqual({
      0: 1,
    });
  });

  it('draws a natural for F after F-sharp in the same bar of C major', () => {
    expect(accidentalsOf('F#4:1/4 F4:1/4 F4:1/4 F#4:1/4')).toEqual({ 0: 1, 1: 0, 3: 1 });
  });

  it('keeps octaves independent: a sharp on F4 does not reach F5 or F3', () => {
    expect(accidentalsOf('F#4:1/4 F5:1/4 F3:1/4 F4:1/4')).toEqual({ 0: 1, 3: 0 }); // only the same pitch (F4) is affected
    expect(accidentalsOf('F#4:1/4 F#5:1/4 F#3:1/4')).toEqual({ 0: 1, 1: 1, 2: 1 });
  });

  it('after a natural in G major, F-sharp needs its sign again in that bar, and not in the next', () => {
    expect(accidentalsOf('F#4:1/4 F4:1/4 F#4:1/4 F#4:1/4 | F#4:1/4 |', { key: 1 })).toEqual({
      1: 0,
      2: 1,
    });
  });

  it('resets at a bar line even when the bar line has a different style', () => {
    expect(accidentalsOf('F#4:1/2 F#4:1/2 || F#4:1/2 F#4:1/2 |]')).toEqual({ 0: 1, 2: 1 });
  });

  it('gives a tied note a single entry (one note element), on its first head', () => {
    expect(accidentalsOf('F#4:1/2~ | F#4:1/2 G4:1/2 |')).toEqual({ 0: 1 });
  });
});

describe('computeDisplayAccidentals: key changes', () => {
  it('resets the defaults at a mid-piece key change', () => {
    // Bar 1 in G major: F-sharp is free. After K:0 (C major) the same F-sharp needs its sign.
    expect(accidentalsOf('F#4:1/1 | K:0 F#4:1/1 | K:1 F#4:1/1 |', { key: 1 })).toEqual({ 1: 1 });
  });

  it('draws a natural for a note that the old key had altered once the key is C major', () => {
    expect(accidentalsOf('F4:1/1 | K:0 F4:1/1 |', { key: 1 })).toEqual({ 0: 0 });
  });

  it('tracks flats after a change from sharps', () => {
    expect(accidentalsOf('F#4:1/1 | K:-2 Bb4:1/1 Eb5:1/1 | B4:1/1 |', { key: 1 })).toEqual({
      3: 0,
    });
  });

  it('ignoreKeySignature draws every sharp and flat as if in C major', () => {
    const piece = buildPiece('F#4:1/4 G4:1/4 Bb4:1/4', { key: 1 });
    expect(
      Object.fromEntries(computeDisplayAccidentals(piece, { ignoreKeySignature: true })),
    ).toEqual({
      0: 1,
      2: -1,
    });
  });
});

describe('computeDisplayAccidentals: robustness', () => {
  it('returns an empty map for an empty piece', () => {
    expect(computeDisplayAccidentals(buildPiece('')).size).toBe(0);
  });

  it('caches per piece', () => {
    const piece = buildPiece('F#4:1/4');
    expect(computeDisplayAccidentals(piece)).toBe(computeDisplayAccidentals(piece));
  });

  it('works on notes without a written spelling (generated sequences spell with sharps)', () => {
    const piece = buildPiece('C4:1/4');
    const bare = { ...piece, notes: piece.notes.map((n) => ({ ...n, spelling: undefined })) };
    expect(computeDisplayAccidentals(bare).size).toBe(0);
  });
});

describe('displayedKeyOffsets', () => {
  it('keeps single sharps and flats and drops anything larger', () => {
    const shown = displayedKeyOffsets({ ...NO_KEY_OFFSETS, F: 1, B: -1, C: 2, E: -2 });
    expect(shown).toEqual({ ...NO_KEY_OFFSETS, F: 1, B: -1 });
  });
});

describe('keySignatureGlyphs', () => {
  const letters = (fifths: number) =>
    keySignatureGlyphs(keyOffsetsForFifths(fifths)).map((g) => g.letter);
  const positions = (fifths: number) =>
    keySignatureGlyphs(keyOffsetsForFifths(fifths)).map((g) => g.position);

  it('prints nothing for C major', () => {
    expect(keySignatureGlyphs(NO_KEY_OFFSETS)).toEqual([]);
  });

  it('adds sharps in the order F C G D A E B', () => {
    expect(letters(7)).toEqual(['F', 'C', 'G', 'D', 'A', 'E', 'B']);
    expect(letters(3)).toEqual(['F', 'C', 'G']);
    expect(
      keySignatureGlyphs(keyOffsetsForFifths(2)).every((g) => g.glyph === 'accidentalSharp'),
    ).toBe(true);
  });

  it('adds flats in the order B E A D G C F', () => {
    expect(letters(-7)).toEqual(['B', 'E', 'A', 'D', 'G', 'C', 'F']);
    expect(letters(-2)).toEqual(['B', 'E']);
    expect(
      keySignatureGlyphs(keyOffsetsForFifths(-2)).every((g) => g.glyph === 'accidentalFlat'),
    ).toBe(true);
  });

  it('places sharps at the standard treble-clef positions (F5 C5 G5 D5 A4 E5 B4)', () => {
    // Half-spaces above the bottom line (E4 = 0).
    expect(positions(7)).toEqual([8, 5, 9, 6, 3, 7, 4]);
  });

  it('places flats at the standard treble-clef positions (B4 E5 A4 D5 G4 C5 F4)', () => {
    expect(positions(-7)).toEqual([4, 7, 3, 6, 2, 5, 1]);
  });

  it('leaves out letters whose offset is not a single sharp or flat', () => {
    expect(keySignatureGlyphs({ ...NO_KEY_OFFSETS, F: 2, C: 1 }).map((g) => g.letter)).toEqual([
      'C',
    ]);
  });

  it('cancels the old signature with naturals when changing key (only the signs that change)', () => {
    const naturals = (from: number, to: number) =>
      keySignatureGlyphs(keyOffsetsForFifths(to), keyOffsetsForFifths(from))
        .filter((g) => g.glyph === 'accidentalNatural')
        .map((g) => g.letter);
    expect(naturals(3, 0)).toEqual(['F', 'C', 'G']);
    expect(naturals(3, 1)).toEqual(['C', 'G']);
    expect(naturals(1, -1)).toEqual(['F']);
    expect(naturals(0, 2)).toEqual([]);
    expect(naturals(-2, 2)).toEqual(['B', 'E']);
  });

  it('puts the naturals first, at the position of the old sign, then the new signs', () => {
    const change = keySignatureGlyphs(keyOffsetsForFifths(-1), keyOffsetsForFifths(1));
    expect(change.map((g) => [g.glyph, g.letter, g.position])).toEqual([
      ['accidentalNatural', 'F', 8],
      ['accidentalFlat', 'B', 4],
    ]);
  });
});
