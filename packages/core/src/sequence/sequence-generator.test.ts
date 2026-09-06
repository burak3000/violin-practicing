import { describe, expect, it } from 'vitest';
import { midiToFrequencyHz } from '../note/note.js';
import { generatePlayingPracticeSequence } from './sequence-generator.js';

const labelsOf = (notes: ReturnType<typeof generatePlayingPracticeSequence>) =>
  notes.map((n) => n.note.label);

describe('generatePlayingPracticeSequence: defaults', () => {
  it('defaults to stepwise-first-position, ascending, all four strings low-to-high', () => {
    const notes = generatePlayingPracticeSequence();
    expect(labelsOf(notes)).toEqual([
      'G3',
      'A3',
      'B3',
      'C4',
      'D4', // G string
      'D4',
      'E4',
      'F#4',
      'G4',
      'A4', // D string
      'A4',
      'B4',
      'C#5',
      'D5',
      'E5', // A string
      'E5',
      'F#5',
      'G#5',
      'A5',
      'B5', // E string
    ]);
  });

  it('every generated note carries its source string and a frequency consistent with its note name', () => {
    const notes = generatePlayingPracticeSequence({ strings: ['G'] });
    for (const n of notes) {
      expect(n.sourceString).toBe('G');
      expect(n.frequencyHz).toBeCloseTo(midiToFrequencyHz(n.note.midi), 6);
    }
  });
});

describe('generatePlayingPracticeSequence: strings configurability', () => {
  it('a single string produces only that string’s notes', () => {
    expect(labelsOf(generatePlayingPracticeSequence({ strings: ['D'] }))).toEqual([
      'D4',
      'E4',
      'F#4',
      'G4',
      'A4',
    ]);
  });

  it('multiple strings are always walked low-to-high regardless of input order', () => {
    const inOrder = generatePlayingPracticeSequence({ strings: ['G', 'A'] });
    const reversed = generatePlayingPracticeSequence({ strings: ['A', 'G'] });
    expect(labelsOf(inOrder)).toEqual(labelsOf(reversed));
    expect(labelsOf(inOrder)[0]).toBe('G3'); // G comes before A
  });

  it('different string selections produce genuinely different sequences', () => {
    const gOnly = labelsOf(generatePlayingPracticeSequence({ strings: ['G'] }));
    const eOnly = labelsOf(generatePlayingPracticeSequence({ strings: ['E'] }));
    expect(gOnly).not.toEqual(eOnly);
  });

  it('throws on an empty strings array', () => {
    expect(() => generatePlayingPracticeSequence({ strings: [] })).toThrow(RangeError);
  });
});

describe('generatePlayingPracticeSequence: patternType configurability', () => {
  it('open-strings-only yields exactly one note per included string', () => {
    const notes = generatePlayingPracticeSequence({ patternType: 'open-strings' });
    expect(labelsOf(notes)).toEqual(['G3', 'D4', 'A4', 'E5']);
  });

  it('one-octave-scale yields 8 notes per string, spanning a full octave', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
    });
    expect(labelsOf(notes)).toEqual(['G3', 'A3', 'B3', 'C4', 'D4', 'E4', 'F#4', 'G4']);
    expect(notes[0]!.note.midi + 12).toBe(notes[notes.length - 1]!.note.midi);
  });

  it('stepwise-first-position yields 5 notes per string (root through perfect 5th)', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['A'],
      patternType: 'stepwise-first-position',
    });
    expect(labelsOf(notes)).toEqual(['A4', 'B4', 'C#5', 'D5', 'E5']);
  });

  it('the three pattern types produce different-length, different-content sequences for the same string', () => {
    const open = generatePlayingPracticeSequence({ strings: ['D'], patternType: 'open-strings' });
    const stepwise = generatePlayingPracticeSequence({
      strings: ['D'],
      patternType: 'stepwise-first-position',
    });
    const octave = generatePlayingPracticeSequence({
      strings: ['D'],
      patternType: 'one-octave-scale',
    });
    expect(open.length).toBe(1);
    expect(stepwise.length).toBe(5);
    expect(octave.length).toBe(8);
    expect(labelsOf(open)).not.toEqual(labelsOf(stepwise));
    expect(labelsOf(stepwise)).not.toEqual(labelsOf(octave));
  });
});

describe('generatePlayingPracticeSequence: direction configurability', () => {
  it('ascending walks root to top', () => {
    const notes = generatePlayingPracticeSequence({ strings: ['G'], direction: 'ascending' });
    expect(labelsOf(notes)).toEqual(['G3', 'A3', 'B3', 'C4', 'D4']);
  });

  it('descending walks top to root', () => {
    const notes = generatePlayingPracticeSequence({ strings: ['G'], direction: 'descending' });
    expect(labelsOf(notes)).toEqual(['D4', 'C4', 'B3', 'A3', 'G3']);
  });

  it('both ascends then descends without repeating the turnaround note', () => {
    const notes = generatePlayingPracticeSequence({ strings: ['G'], direction: 'both' });
    expect(labelsOf(notes)).toEqual(['G3', 'A3', 'B3', 'C4', 'D4', 'C4', 'B3', 'A3', 'G3']);
  });

  it('ascending and descending are reverses of each other', () => {
    const ascending = labelsOf(
      generatePlayingPracticeSequence({ strings: ['A'], direction: 'ascending' }),
    );
    const descending = labelsOf(
      generatePlayingPracticeSequence({ strings: ['A'], direction: 'descending' }),
    );
    expect(descending).toEqual([...ascending].reverse());
  });

  it('direction applies per-string before strings are concatenated', () => {
    const notes = generatePlayingPracticeSequence({ strings: ['G', 'D'], direction: 'descending' });
    expect(labelsOf(notes)).toEqual(['D4', 'C4', 'B3', 'A3', 'G3', 'A4', 'G4', 'F#4', 'E4', 'D4']);
  });
});

describe('generatePlayingPracticeSequence: range configurability', () => {
  it('defaults match packages/dsp-native ForViolin search range (150-1600Hz)', () => {
    // one-octave E string reaches E6 (~1318.5Hz); still inside the default
    // range, so nothing should be silently dropped at these defaults.
    const notes = generatePlayingPracticeSequence({
      strings: ['E'],
      patternType: 'one-octave-scale',
    });
    expect(labelsOf(notes)).toEqual(['E5', 'F#5', 'G#5', 'A5', 'B5', 'C#6', 'D#6', 'E6']);
  });

  it('a narrower range filters out notes above the max', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
      maxFrequencyHz: midiToFrequencyHz(60), // C4
    });
    expect(labelsOf(notes)).toEqual(['G3', 'A3', 'B3', 'C4']);
  });

  it('a narrower range filters out notes below the min', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
      minFrequencyHz: midiToFrequencyHz(60), // C4
    });
    expect(labelsOf(notes)).toEqual(['C4', 'D4', 'E4', 'F#4', 'G4']);
  });

  it('a range that excludes everything returns an empty array rather than throwing', () => {
    const notes = generatePlayingPracticeSequence({
      strings: ['G'],
      minFrequencyHz: 5000,
      maxFrequencyHz: 6000,
    });
    expect(notes).toEqual([]);
  });

  it('throws when minFrequencyHz > maxFrequencyHz', () => {
    expect(() =>
      generatePlayingPracticeSequence({ minFrequencyHz: 1000, maxFrequencyHz: 500 }),
    ).toThrow(RangeError);
  });

  it('range is evaluated at the configured a4Hz, not a fixed Hz table', () => {
    const at440 = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
      maxFrequencyHz: 200, // excludes everything above ~G3 at A4=440
    });
    const at470 = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'one-octave-scale',
      maxFrequencyHz: 200, // the same absolute ceiling now excludes G3 itself once A4 is raised
      a4Hz: 470,
    });
    expect(labelsOf(at440)).toEqual(['G3']);
    expect(at470).toEqual([]);
  });
});

describe('generatePlayingPracticeSequence: a4Hz configurability', () => {
  it('is not hardcoded to 440 -- every note shifts consistently with a different reference pitch', () => {
    const at440 = generatePlayingPracticeSequence({ strings: ['A'], a4Hz: 440 });
    const at442 = generatePlayingPracticeSequence({ strings: ['A'], a4Hz: 442 });
    expect(labelsOf(at440)).toEqual(labelsOf(at442)); // same note names...
    for (let i = 0; i < at440.length; i += 1) {
      expect(at442[i]!.frequencyHz).toBeGreaterThan(at440[i]!.frequencyHz); // ...but higher Hz throughout
    }
  });
});
