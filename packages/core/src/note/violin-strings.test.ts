import { describe, expect, it } from 'vitest';
import { midiNumberToNoteName } from './note.js';
import {
  FIRST_POSITION_SEMITONE_OFFSETS,
  MAJOR_SCALE_SEMITONE_OFFSETS,
  OPEN_STRING_NOTE_NAMES,
  VIOLIN_STRING_ORDER,
  openStringFrequencyHz,
  openStringNote,
} from './violin-strings.js';

describe('open strings', () => {
  it('are named G3, D4, A4, E5 in low-to-high order', () => {
    expect(VIOLIN_STRING_ORDER).toEqual(['G', 'D', 'A', 'E']);
    expect(OPEN_STRING_NOTE_NAMES).toEqual({ G: 'G3', D: 'D4', A: 'A4', E: 'E5' });
  });

  it('reproduce the plan-cited open-string frequencies at the default A4=440', () => {
    expect(openStringFrequencyHz('G')).toBeCloseTo(196.0, 1);
    expect(openStringFrequencyHz('D')).toBeCloseTo(293.66, 1);
    expect(openStringFrequencyHz('A')).toBeCloseTo(440.0, 1);
    expect(openStringFrequencyHz('E')).toBeCloseTo(659.25, 1);
  });

  it('are tuned in ascending perfect fifths (7 semitones apart)', () => {
    expect(openStringNote('D').midi - openStringNote('G').midi).toBe(7);
    expect(openStringNote('A').midi - openStringNote('D').midi).toBe(7);
    expect(openStringNote('E').midi - openStringNote('A').midi).toBe(7);
  });

  it('shift with a non-default a4Hz (reference pitch is configurable, not hardcoded)', () => {
    const at440 = openStringFrequencyHz('A', 440);
    const at442 = openStringFrequencyHz('A', 442);
    expect(at442).toBeCloseTo(442, 6);
    expect(at442).not.toBeCloseTo(at440, 3);
  });
});

describe('first-position / one-octave-scale semitone offsets', () => {
  it('first-position offsets are the bottom 5 of the one-octave scale (root through perfect 5th)', () => {
    expect(FIRST_POSITION_SEMITONE_OFFSETS).toEqual([0, 2, 4, 5, 7]);
    expect(MAJOR_SCALE_SEMITONE_OFFSETS.slice(0, FIRST_POSITION_SEMITONE_OFFSETS.length)).toEqual(
      FIRST_POSITION_SEMITONE_OFFSETS,
    );
  });

  it('one-octave scale spans a full octave (12 semitones)', () => {
    expect(MAJOR_SCALE_SEMITONE_OFFSETS[0]).toBe(0);
    expect(MAJOR_SCALE_SEMITONE_OFFSETS[MAJOR_SCALE_SEMITONE_OFFSETS.length - 1]).toBe(12);
  });

  it('matches the researched first-position finger chart per string (Violin Lounge / Violinspiration)', () => {
    // G string first position: G(open) A B C D -- matches
    // https://violinlounge.com/article/violin-first-position-explained-with-finger-charts-notes-and-videos/
    const labelsFor = (stringName: 'G' | 'D' | 'A' | 'E') =>
      FIRST_POSITION_SEMITONE_OFFSETS.map(
        (offset) => midiNumberToNoteName(openStringNote(stringName).midi + offset).label,
      );

    expect(labelsFor('G')).toEqual(['G3', 'A3', 'B3', 'C4', 'D4']);
    expect(labelsFor('D')).toEqual(['D4', 'E4', 'F#4', 'G4', 'A4']);
    expect(labelsFor('A')).toEqual(['A4', 'B4', 'C#5', 'D5', 'E5']);
    expect(labelsFor('E')).toEqual(['E5', 'F#5', 'G#5', 'A5', 'B5']);
  });
});
