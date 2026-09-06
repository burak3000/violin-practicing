import { describe, expect, it } from 'vitest';
import {
  DEFAULT_A4_HZ,
  analyzeFrequency,
  centsOffNearestNote,
  describeFrequency,
  frequencyHzToMidi,
  frequencyToCents,
  midiNumberToNoteName,
  midiToFrequencyHz,
  noteNameToFrequencyHz,
  parseNoteName,
} from './note.js';

describe('midiToFrequencyHz / frequencyHzToMidi', () => {
  it('A4 (midi 69) is exactly a4Hz', () => {
    expect(midiToFrequencyHz(69)).toBeCloseTo(440, 9);
    expect(midiToFrequencyHz(69, 442)).toBeCloseTo(442, 9);
  });

  it('reproduces the plan-cited open-string frequencies at the default A4=440', () => {
    // G3, D4, A4, E5 -> 196.00, 293.66, 440.00, 659.25 (plan citation [15]).
    expect(midiToFrequencyHz(55)).toBeCloseTo(196.0, 1);
    expect(midiToFrequencyHz(62)).toBeCloseTo(293.66, 1);
    expect(midiToFrequencyHz(69)).toBeCloseTo(440.0, 1);
    expect(midiToFrequencyHz(76)).toBeCloseTo(659.25, 1);
  });

  it('is the exact inverse of frequencyHzToMidi across a range of notes and tunings', () => {
    for (const a4Hz of [438, 440, 442]) {
      for (let midi = 40; midi <= 100; midi += 3.25) {
        const hz = midiToFrequencyHz(midi, a4Hz);
        expect(frequencyHzToMidi(hz, a4Hz)).toBeCloseTo(midi, 9);
      }
    }
  });

  it('frequencyHzToMidi throws on non-positive frequency', () => {
    expect(() => frequencyHzToMidi(0)).toThrow(RangeError);
    expect(() => frequencyHzToMidi(-10)).toThrow(RangeError);
  });
});

describe('frequencyToCents', () => {
  it('is 0 when frequency equals the reference', () => {
    expect(frequencyToCents(440, 440)).toBeCloseTo(0, 9);
  });

  it('is +1200 for one octave up and -1200 for one octave down', () => {
    expect(frequencyToCents(880, 440)).toBeCloseTo(1200, 6);
    expect(frequencyToCents(220, 440)).toBeCloseTo(-1200, 6);
  });

  it('is +100/-100 for one equal-tempered semitone up/down', () => {
    const semitoneUp = 440 * 2 ** (1 / 12);
    const semitoneDown = 440 * 2 ** (-1 / 12);
    expect(frequencyToCents(semitoneUp, 440)).toBeCloseTo(100, 6);
    expect(frequencyToCents(semitoneDown, 440)).toBeCloseTo(-100, 6);
  });

  it('throws on non-positive arguments', () => {
    expect(() => frequencyToCents(0, 440)).toThrow(RangeError);
    expect(() => frequencyToCents(440, 0)).toThrow(RangeError);
    expect(() => frequencyToCents(-1, 440)).toThrow(RangeError);
  });
});

describe('midiNumberToNoteName', () => {
  it('resolves well-known notes correctly (C4 = middle C = midi 60)', () => {
    expect(midiNumberToNoteName(60)).toEqual({ pitchClass: 'C', octave: 4, midi: 60, label: 'C4' });
    expect(midiNumberToNoteName(69)).toEqual({ pitchClass: 'A', octave: 4, midi: 69, label: 'A4' });
    expect(midiNumberToNoteName(55)).toEqual({ pitchClass: 'G', octave: 3, midi: 55, label: 'G3' });
  });

  it('handles octave boundaries correctly (B->C rolls the octave over)', () => {
    expect(midiNumberToNoteName(59)).toEqual({ pitchClass: 'B', octave: 3, midi: 59, label: 'B3' });
    expect(midiNumberToNoteName(60)).toEqual({ pitchClass: 'C', octave: 4, midi: 60, label: 'C4' });
  });

  it('rounds fractional midi numbers to the nearest integer', () => {
    expect(midiNumberToNoteName(69.4).label).toBe('A4');
    expect(midiNumberToNoteName(69.6).label).toBe('A#4');
  });

  it('handles low midi numbers (negative octave) without throwing', () => {
    // midi 0 = C-1 in scientific pitch notation.
    expect(midiNumberToNoteName(0)).toEqual({ pitchClass: 'C', octave: -1, midi: 0, label: 'C-1' });
  });
});

describe('analyzeFrequency / centsOffNearestNote', () => {
  it('reports 0 cents exactly on a note', () => {
    const { note, cents } = analyzeFrequency(440);
    expect(note.label).toBe('A4');
    expect(cents).toBeCloseTo(0, 9);
  });

  it('reports a positive (sharp) cents offset for a slightly-high frequency', () => {
    const analysis = analyzeFrequency(445); // ~+19.6c off A4 at A4=440
    expect(analysis.note.label).toBe('A4');
    expect(analysis.cents).toBeGreaterThan(0);
    expect(analysis.cents).toBeCloseTo(19.6, 1);
  });

  it('reports a negative (flat) cents offset for a slightly-low frequency', () => {
    const analysis = analyzeFrequency(435);
    expect(analysis.note.label).toBe('A4');
    expect(analysis.cents).toBeLessThan(0);
  });

  it('snaps to the nearer neighbor across the halfway point between two notes', () => {
    const halfway = midiToFrequencyHz(69.5); // exactly between A4 and A#4
    const justBelow = analyzeFrequency(halfway - 0.01);
    const justAbove = analyzeFrequency(halfway + 0.01);
    expect(justBelow.note.label).toBe('A4');
    expect(justAbove.note.label).toBe('A#4');
  });

  it('centsOffNearestNote agrees with analyzeFrequency', () => {
    expect(centsOffNearestNote(445)).toBeCloseTo(analyzeFrequency(445).cents, 9);
  });

  it('respects a non-default a4Hz reference (e.g. A442)', () => {
    const analysis = analyzeFrequency(442, 442);
    expect(analysis.note.label).toBe('A4');
    expect(analysis.cents).toBeCloseTo(0, 6);
    // The same 440Hz signal is now flat relative to a A442 reference.
    expect(analyzeFrequency(440, 442).cents).toBeLessThan(0);
  });
});

describe('parseNoteName', () => {
  it('parses plain natural notes', () => {
    expect(parseNoteName('G3')).toEqual({ pitchClass: 'G', octave: 3, midi: 55, label: 'G3' });
    expect(parseNoteName('A4')).toEqual({ pitchClass: 'A', octave: 4, midi: 69, label: 'A4' });
  });

  it('parses sharps and is case-insensitive on the letter', () => {
    expect(parseNoteName('C#5')?.label).toBe('C#5');
    expect(parseNoteName('c#5')?.label).toBe('C#5');
  });

  it('parses flats and canonicalizes them to the sharp spelling', () => {
    const bFlat4 = parseNoteName('Bb4');
    expect(bFlat4?.pitchClass).toBe('A#');
    expect(bFlat4?.label).toBe('A#4');
    expect(bFlat4?.midi).toBe(parseNoteName('A#4')?.midi);
  });

  it('handles flat-wrapping below C (Cb4 == B3) and sharp-wrapping above B (B#4 == C5)', () => {
    expect(parseNoteName('Cb4')?.label).toBe('B3');
    expect(parseNoteName('B#4')?.label).toBe('C5');
  });

  it('returns undefined for garbage input', () => {
    expect(parseNoteName('')).toBeUndefined();
    expect(parseNoteName('H4')).toBeUndefined();
    expect(parseNoteName('G')).toBeUndefined();
    expect(parseNoteName('G#')).toBeUndefined();
    expect(parseNoteName('violin')).toBeUndefined();
    expect(parseNoteName('G3.5')).toBeUndefined();
  });

  it('round-trips through noteNameToFrequencyHz and midiToFrequencyHz', () => {
    const note = parseNoteName('D4')!;
    expect(noteNameToFrequencyHz('D4')).toBeCloseTo(midiToFrequencyHz(note.midi), 9);
  });

  it('noteNameToFrequencyHz returns undefined for an unparsable name', () => {
    expect(noteNameToFrequencyHz('nonsense')).toBeUndefined();
  });

  it('noteNameToFrequencyHz respects a4Hz', () => {
    expect(noteNameToFrequencyHz('A4', 442)).toBeCloseTo(442, 9);
  });
});

describe('describeFrequency', () => {
  it('formats an exact note with a signed zero', () => {
    expect(describeFrequency(440)).toBe('A4 +0c');
  });

  it('formats sharp and flat offsets with an explicit sign', () => {
    expect(describeFrequency(445)).toMatch(/^A4 \+\d+c$/);
    expect(describeFrequency(435)).toMatch(/^A4 -\d+c$/);
  });

  it('returns a placeholder for non-positive frequency', () => {
    expect(describeFrequency(0)).toBe('(no pitch)');
    expect(describeFrequency(-5)).toBe('(no pitch)');
  });

  it('DEFAULT_A4_HZ is 440', () => {
    expect(DEFAULT_A4_HZ).toBe(440);
  });
});
