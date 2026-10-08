import { describe, expect, it } from 'vitest';
import { parseAbc } from './abc-parser.js';
import { abcPracticeSummary, abcTuneLabel, buildAbcPracticeSequence } from './abc-practice.js';
import { PracticeSessionController } from '../practice/practice-session-controller.js';

function tuneOf(body: string, key = 'C') {
  return parseAbc(`X:1\nT:Test\nK:${key}\n${body}\n`).tunes[0]!;
}

describe('buildAbcPracticeSequence: ok path', () => {
  it('turns the first voice into SequenceNotes with names and equal-tempered frequencies', () => {
    const result = buildAbcPracticeSequence(tuneOf('G, A, B, C D E F G'));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.notes.map((n) => n.note.label)).toEqual([
      'G3',
      'A3',
      'B3',
      'C4',
      'D4',
      'E4',
      'F4',
      'G4',
    ]);
    // Open G string is 196.00Hz at A4=440 (violin-strings.ts's cited value).
    expect(result.notes[0]!.frequencyHz).toBeCloseTo(195.998, 2);
    expect(result.notes[0]!.sourceString).toBeUndefined();
    expect(result.lowest.label).toBe('G3');
    expect(result.highest.label).toBe('G4');
    expect(result.transposeSemitones).toBe(0);
  });

  it('honours a non-default reference pitch', () => {
    const result = buildAbcPracticeSequence(tuneOf('A'), { a4Hz: 442 });
    expect(result.status === 'ok' && result.notes[0]!.frequencyHz).toBeCloseTo(442, 6);
  });

  it('applies a transposition before building the notes', () => {
    const result = buildAbcPracticeSequence(tuneOf('G, A,'), { transposeSemitones: 12 });
    expect(result.status === 'ok' && result.notes.map((n) => n.note.label)).toEqual(['G4', 'A4']);
  });

  it('accepts notes right at the limits: open G and the 1600Hz ceiling (G6 = 1567.98Hz)', () => {
    const result = buildAbcPracticeSequence(tuneOf("G, g'"));
    expect(result.status).toBe('ok');
  });

  it('picks the requested voice, and the first non-empty voice by default', () => {
    const tune = parseAbc('X:1\nV:1\nV:2\nK:C\n[V:1] C D |\n[V:2] G, A, B, |\n').tunes[0]!;
    const byDefault = buildAbcPracticeSequence(tune);
    expect(byDefault.status === 'ok' && byDefault.notes.map((n) => n.note.label)).toEqual([
      'C4',
      'D4',
    ]);
    const second = buildAbcPracticeSequence(tune, { voiceId: '2' });
    expect(second.status === 'ok' && second.notes.map((n) => n.note.label)).toEqual([
      'G3',
      'A3',
      'B3',
    ]);
    expect(second.status === 'ok' && second.voiceId).toBe('2');
  });

  it('feeds a PracticeSessionController like any generated sequence', () => {
    const result = buildAbcPracticeSequence(tuneOf('G A B'));
    if (result.status !== 'ok') throw new Error('expected ok');
    const controller = new PracticeSessionController(result.notes);
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 0 });
    controller.reportOutcome('success');
    controller.reportOutcome('success');
    controller.reportOutcome('success');
    expect(controller.state.mode).toBe('complete');
  });
});

describe('buildAbcPracticeSequence: empty', () => {
  it('reports a tune with no notes', () => {
    const result = buildAbcPracticeSequence(tuneOf('z4 |'));
    expect(result.status).toBe('empty');
  });

  it('reports an unknown voice id', () => {
    const result = buildAbcPracticeSequence(tuneOf('C D'), { voiceId: 'nope' });
    expect(result).toMatchObject({ status: 'empty' });
  });
});

describe('buildAbcPracticeSequence: range handling refuses rather than drops', () => {
  it('rejects a tune with notes below the violin (C3) and suggests going up an octave', () => {
    const result = buildAbcPracticeSequence(tuneOf('C, D, E, F, G,'));
    expect(result.status).toBe('out-of-range');
    if (result.status !== 'out-of-range') return;
    // C3, D3, E3, F3 are below G3.
    expect(result.outOfRangeCount).toBe(4);
    expect(result.noteCount).toBe(5);
    expect(result.suggestedTransposeSemitones).toBe(12);
    expect(result.message).toContain('4 of 5');
    expect(result.message).toContain('up an octave');
  });

  it('rejects a tune above the detector ceiling (C7 = 2093Hz) and suggests going down', () => {
    const result = buildAbcPracticeSequence(tuneOf("c'' d''"));
    expect(result.status).toBe('out-of-range');
    if (result.status !== 'out-of-range') return;
    expect(result.suggestedTransposeSemitones).toBe(-12);
    expect(result.message).toContain('down an octave');
  });

  it('suggests a shift that works, and applying it succeeds', () => {
    const tune = tuneOf('C, E, G,');
    const first = buildAbcPracticeSequence(tune);
    expect(first.status).toBe('out-of-range');
    if (first.status !== 'out-of-range') return;
    const second = buildAbcPracticeSequence(tune, {
      transposeSemitones: first.suggestedTransposeSemitones,
    });
    expect(second.status).toBe('ok');
  });

  it('says so when no whole-octave shift can fit the tune (too wide for a violin)', () => {
    const result = buildAbcPracticeSequence(tuneOf("C, c'''"));
    expect(result.status).toBe('out-of-range');
    if (result.status !== 'out-of-range') return;
    expect(result.suggestedTransposeSemitones).toBeUndefined();
    expect(result.message).toContain('No whole-octave shift');
  });

  it('reports a suggested shift relative to the transposition already applied', () => {
    const result = buildAbcPracticeSequence(tuneOf('C, D,'), { transposeSemitones: 12 });
    // C3/D3 shifted up an octave are C4/D4: playable.
    expect(result.status).toBe('ok');
    const stillLow = buildAbcPracticeSequence(tuneOf('C,, D,,'), { transposeSemitones: 12 });
    expect(stillLow.status).toBe('out-of-range');
    if (stillLow.status !== 'out-of-range') return;
    expect(stillLow.suggestedTransposeSemitones).toBe(24);
  });

  it('respects a caller-supplied frequency ceiling', () => {
    const result = buildAbcPracticeSequence(tuneOf("a'"), { maxFrequencyHz: 800 });
    expect(result.status).toBe('out-of-range');
  });
});

describe('abcTuneLabel / abcPracticeSummary', () => {
  it('labels a tune by its X: number and title, falling back to position and "Untitled"', () => {
    expect(abcTuneLabel(parseAbc('X:7\nT:Reel\nK:C\nC\n').tunes[0]!)).toBe('7: Reel');
    expect(abcTuneLabel(parseAbc('K:C\nC\n').tunes[0]!)).toBe('1: Untitled');
  });

  it('summarizes a practicable tune: heading, count and range, first notes', () => {
    const tune = tuneOf('G, A, B,', 'G');
    expect(abcPracticeSummary(tune, buildAbcPracticeSequence(tune))).toBe(
      'Test \u00b7 key G\n3 notes, G3 to B3\nG3 A3 B3',
    );
  });

  it('elides a long note list', () => {
    const tune = tuneOf('G, A, B, C D E F G A B c d e f g');
    const summary = abcPracticeSummary(tune, buildAbcPracticeSequence(tune));
    expect(summary.split('\n')[2]).toBe('G3 A3 B3 C4 D4 E4 F4 G4 A4 B4 C5 D5 \u2026');
  });

  it('is just the heading when the tune cannot be practiced', () => {
    const tune = tuneOf('C,');
    expect(abcPracticeSummary(tune, buildAbcPracticeSequence(tune))).toBe('Test \u00b7 key C');
  });
});
