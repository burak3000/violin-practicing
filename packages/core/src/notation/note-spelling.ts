/**
 * How a note is *written* on a staff: a letter, an accidental and an octave.
 *
 * `NoteName` (note/note.ts) identifies a pitch by its MIDI number with a
 * sharps-only label ("A#4"), which is right for naming what a detector heard
 * but loses the distinction a sheet draws: B-flat and A-sharp sound the same
 * and sit on different staff lines. ABC files spell notes explicitly, so the
 * parser keeps that spelling, and the staff display draws it as written. For
 * notes with no written spelling (the procedural scale patterns, which only
 * use sharp keys), `spellMidi` gives the sharps-only spelling, matching
 * `NoteName`.
 */

export type NoteLetter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

export interface NoteSpelling {
  readonly letter: NoteLetter;
  /** Semitones above (+) or below (-) the natural letter: -2 (double flat) .. +2 (double sharp). */
  readonly accidental: number;
  /** Scientific pitch notation octave; C4 is middle C. */
  readonly octave: number;
}

export const NOTE_LETTERS: readonly NoteLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const LETTER_SEMITONES: Readonly<Record<NoteLetter, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Pitch class (0 = C) -> sharps-only spelling, matching `PITCH_CLASS_NAMES` in note/note.ts. */
const SHARP_SPELLING_BY_PITCH_CLASS: ReadonlyArray<readonly [NoteLetter, number]> = [
  ['C', 0],
  ['C', 1],
  ['D', 0],
  ['D', 1],
  ['E', 0],
  ['F', 0],
  ['F', 1],
  ['G', 0],
  ['G', 1],
  ['A', 0],
  ['A', 1],
  ['B', 0],
];

/** The MIDI number a spelling sounds at (C4 = 60). `Cb4` is 59 and `B#3` is 60: the octave belongs to the letter, not the sounding pitch. */
export function spellingToMidi(spelling: NoteSpelling): number {
  return 12 * (spelling.octave + 1) + LETTER_SEMITONES[spelling.letter] + spelling.accidental;
}

/** Sharps-only spelling of a MIDI note (rounded to the nearest integer), as `midiNumberToNoteName` would label it. */
export function spellMidi(midiNumber: number): NoteSpelling {
  const midi = Math.round(midiNumber);
  const pitchClass = ((midi % 12) + 12) % 12;
  const [letter, accidental] = SHARP_SPELLING_BY_PITCH_CLASS[pitchClass]!;
  return { letter, accidental, octave: Math.floor(midi / 12) - 1 };
}

/**
 * Shifts a spelling by `semitones`. A whole number of octaves keeps the
 * letter and accidental exactly as written (a transposed B-flat is still a
 * B-flat); any other shift has no single "right" spelling, so it falls back
 * to the sharps-only one.
 */
export function transposeSpelling(spelling: NoteSpelling, semitones: number): NoteSpelling {
  if (semitones % 12 === 0) {
    return { ...spelling, octave: spelling.octave + semitones / 12 };
  }
  return spellMidi(spellingToMidi(spelling) + semitones);
}

/** "Bb4", "F#5", "C4", "F##4", "Bbb3" -- for accessible labels, not for UI display of detected pitches. */
export function formatSpelling(spelling: NoteSpelling): string {
  const sign =
    spelling.accidental > 0 ? '#'.repeat(spelling.accidental) : 'b'.repeat(-spelling.accidental);
  return `${spelling.letter}${sign}${spelling.octave}`;
}

// --- Display labels and key-aware spelling ---------------------------------------

const ACCIDENTAL_SIGNS: Readonly<Record<string, string>> = {
  '-2': '♭♭',
  '-1': '♭',
  '0': '',
  '1': '♯',
  '2': '♯♯',
};

/**
 * How a spelling reads on screen: "B♭4", "F♯5", "C4" -- the real flat/sharp
 * signs, and the spelling the *sheet* uses (so B-flat is never shown as
 * A-sharp). `formatSpelling` above is the ASCII form ("Bb4") for accessible
 * labels and tests.
 */
export function formatSpellingLabel(spelling: NoteSpelling): string {
  const sign = ACCIDENTAL_SIGNS[String(spelling.accidental)] ?? '';
  return `${spelling.letter}${sign}${spelling.octave}`;
}

/** Pitch class -> flat-side spelling for the notes that are not natural. */
const FLAT_SPELLING_BY_PITCH_CLASS: ReadonlyArray<readonly [NoteLetter, number]> = [
  ['C', 0],
  ['D', -1],
  ['D', 0],
  ['E', -1],
  ['E', 0],
  ['F', 0],
  ['G', -1],
  ['G', 0],
  ['A', -1],
  ['A', 0],
  ['B', -1],
  ['B', 0],
];

/**
 * Spells a sounding pitch (a MIDI number, e.g. what the detector heard) the
 * way a piece in this key would write it. A note that belongs to the key keeps
 * the key's own spelling (B-flat in F major, F-sharp in G major); a chromatic
 * note is spelled with flats in a flat key (or a key with no signature that
 * is flat-leaning) and with sharps otherwise.
 */
export function spellMidiInKey(
  midiNumber: number,
  keyOffsets: Readonly<Record<NoteLetter, number>>,
): NoteSpelling {
  const midi = Math.round(midiNumber);
  const pitchClass = ((midi % 12) + 12) % 12;
  for (const letter of NOTE_LETTERS) {
    const offset = keyOffsets[letter];
    if ((LETTER_SEMITONES[letter] + offset + 120) % 12 === pitchClass) {
      return {
        letter,
        accidental: offset,
        octave: (midi - LETTER_SEMITONES[letter] - offset) / 12 - 1,
      };
    }
  }
  const total = NOTE_LETTERS.reduce((sum, letter) => sum + keyOffsets[letter], 0);
  if (total < 0) {
    const [letter, accidental] = FLAT_SPELLING_BY_PITCH_CLASS[pitchClass]!;
    return { letter, accidental, octave: (midi - LETTER_SEMITONES[letter] - accidental) / 12 - 1 };
  }
  return spellMidi(midi);
}
