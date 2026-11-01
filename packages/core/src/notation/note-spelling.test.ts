import { describe, expect, it } from 'vitest';
import {
  formatSpelling,
  formatSpellingLabel,
  spellMidi,
  spellMidiInKey,
  spellingToMidi,
  transposeSpelling,
  type NoteLetter,
  type NoteSpelling,
} from './note-spelling.js';

const sp = (letter: NoteSpelling['letter'], accidental: number, octave: number): NoteSpelling => ({
  letter,
  accidental,
  octave,
});

describe('spellMidi: sharps-only spelling of a MIDI number', () => {
  it('spells naturals, middle C and the octave boundaries', () => {
    expect(spellMidi(60)).toEqual(sp('C', 0, 4));
    expect(spellMidi(71)).toEqual(sp('B', 0, 4));
    expect(spellMidi(72)).toEqual(sp('C', 0, 5));
    expect(spellMidi(59)).toEqual(sp('B', 0, 3));
    expect(spellMidi(55)).toEqual(sp('G', 0, 3)); // the violin's open G
    expect(spellMidi(0)).toEqual(sp('C', 0, -1));
  });

  it('spells black keys as sharps (matching NoteName), never flats', () => {
    expect(spellMidi(61)).toEqual(sp('C', 1, 4));
    expect(spellMidi(66)).toEqual(sp('F', 1, 4));
    expect(spellMidi(70)).toEqual(sp('A', 1, 4));
  });

  it('rounds a fractional MIDI number', () => {
    expect(spellMidi(69.4)).toEqual(sp('A', 0, 4));
    expect(spellMidi(69.6)).toEqual(sp('A', 1, 4));
  });
});

describe('spellingToMidi', () => {
  it('inverts spellMidi for every MIDI number in a wide range', () => {
    for (let midi = 0; midi <= 127; midi += 1) {
      expect(spellingToMidi(spellMidi(midi))).toBe(midi);
    }
  });

  it('keeps the octave with the letter: Cb4 sounds a semitone below C4, B#3 equals C4', () => {
    expect(spellingToMidi(sp('C', -1, 4))).toBe(59);
    expect(spellingToMidi(sp('B', 1, 3))).toBe(60);
  });

  it('reads flats and double accidentals', () => {
    expect(spellingToMidi(sp('B', -1, 4))).toBe(70);
    expect(spellingToMidi(sp('F', 2, 4))).toBe(67);
    expect(spellingToMidi(sp('B', -2, 3))).toBe(57);
  });
});

describe('transposeSpelling', () => {
  it('moves whole octaves without changing the letter or accidental', () => {
    expect(transposeSpelling(sp('B', -1, 4), 12)).toEqual(sp('B', -1, 5));
    expect(transposeSpelling(sp('F', 1, 4), -24)).toEqual(sp('F', 1, 2));
    expect(transposeSpelling(sp('C', 0, 4), 0)).toEqual(sp('C', 0, 4));
  });

  it('falls back to the sharps-only spelling for any other shift', () => {
    expect(transposeSpelling(sp('C', 0, 4), 7)).toEqual(sp('G', 0, 4));
    expect(transposeSpelling(sp('B', -1, 4), 1)).toEqual(sp('B', 0, 4));
    expect(transposeSpelling(sp('B', -1, 4), -1)).toEqual(sp('A', 0, 4));
  });
});

describe('formatSpelling', () => {
  it('writes the accidental after the letter', () => {
    expect(formatSpelling(sp('C', 0, 4))).toBe('C4');
    expect(formatSpelling(sp('B', -1, 4))).toBe('Bb4');
    expect(formatSpelling(sp('F', 1, 5))).toBe('F#5');
    expect(formatSpelling(sp('F', 2, 4))).toBe('F##4');
    expect(formatSpelling(sp('B', -2, 3))).toBe('Bbb3');
  });
});

describe('formatSpellingLabel', () => {
  it("writes the real flat and sharp signs, in the sheet's own spelling", () => {
    expect(formatSpellingLabel(sp('B', -1, 4))).toBe('B\u266d4');
    expect(formatSpellingLabel(sp('F', 1, 5))).toBe('F\u266f5');
    expect(formatSpellingLabel(sp('C', 0, 4))).toBe('C4');
    expect(formatSpellingLabel(sp('F', 2, 4))).toBe('F\u266f\u266f4');
    expect(formatSpellingLabel(sp('B', -2, 3))).toBe('B\u266d\u266d3');
  });
});

describe('spellMidiInKey: how a piece in this key would write a heard pitch', () => {
  const key = (altered: Partial<Record<NoteLetter, number>>): Record<NoteLetter, number> => ({
    C: 0,
    D: 0,
    E: 0,
    F: 0,
    G: 0,
    A: 0,
    B: 0,
    ...altered,
  });
  const cMajor = key({});
  const gMajor = key({ F: 1 });
  const fMajor = key({ B: -1 });
  const dMajor = key({ F: 1, C: 1 });
  const eFlatMajor = key({ B: -1, E: -1, A: -1 });

  it("uses the key's own spelling for notes in the key: B-flat in F major, F-sharp in G major", () => {
    expect(spellMidiInKey(70, fMajor)).toEqual(sp('B', -1, 4));
    expect(spellMidiInKey(66, gMajor)).toEqual(sp('F', 1, 4));
    expect(spellMidiInKey(61, dMajor)).toEqual(sp('C', 1, 4));
    expect(spellMidiInKey(63, eFlatMajor)).toEqual(sp('E', -1, 4));
  });

  it('keeps naturals natural and gets the octave right', () => {
    expect(spellMidiInKey(60, cMajor)).toEqual(sp('C', 0, 4));
    expect(spellMidiInKey(71, cMajor)).toEqual(sp('B', 0, 4));
    expect(spellMidiInKey(72, cMajor)).toEqual(sp('C', 0, 5));
    expect(spellMidiInKey(55, gMajor)).toEqual(sp('G', 0, 3));
  });

  it("handles keys whose letters wrap an octave boundary (C-flat major's Cb is the B below)", () => {
    const cFlat = key({ B: -1, E: -1, A: -1, D: -1, G: -1, C: -1, F: -1 });
    expect(spellMidiInKey(59, cFlat)).toEqual(sp('C', -1, 4));
    expect(spellMidiInKey(71, cFlat)).toEqual(sp('C', -1, 5));
    const cSharp = key({ F: 1, C: 1, G: 1, D: 1, A: 1, E: 1, B: 1 });
    expect(spellMidiInKey(60, cSharp)).toEqual(sp('B', 1, 3));
  });

  it('spells a chromatic note with flats in a flat key and sharps otherwise', () => {
    expect(spellMidiInKey(61, fMajor)).toEqual(sp('D', -1, 4));
    expect(spellMidiInKey(68, fMajor)).toEqual(sp('A', -1, 4));
    expect(spellMidiInKey(61, cMajor)).toEqual(sp('C', 1, 4));
    expect(spellMidiInKey(68, gMajor)).toEqual(sp('G', 1, 4));
  });

  it('always sounds at the pitch asked for', () => {
    for (const k of [cMajor, gMajor, fMajor, dMajor, eFlatMajor]) {
      for (let midi = 40; midi <= 100; midi += 1) {
        expect(spellingToMidi(spellMidiInKey(midi, k))).toBe(midi);
      }
    }
  });
});
