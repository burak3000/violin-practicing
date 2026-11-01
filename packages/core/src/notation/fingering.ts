import type { SequenceNote } from '../sequence/sequence-generator.js';

/**
 * Violin finger numbers for ABC practice: 0 = open string, 1-4 = index to
 * little finger. A number comes from the file (`!2!` before a note) or, where
 * the file has none, from a first-position suggestion.
 */
export interface FingerMark {
  readonly finger: number;
  /** `file`: written in the ABC file. `suggested`: worked out here, first position only. */
  readonly source: 'file' | 'suggested';
}

/** MIDI numbers of the open strings, low to high: G3 D4 A4 E5. */
const OPEN_STRING_MIDI = [55, 62, 69, 76] as const;

/**
 * Finger for each semitone above an open string in first position. A semitone
 * pair shares a finger (low and high placement of the same finger): 1 covers 1-2,
 * 2 covers 3-4, 3 covers 5-6, and 4 is a whole step above the third (7).
 */
const FINGER_BY_SEMITONES = [0, 1, 1, 2, 2, 3, 3, 4] as const;

/**
 * A first-position fingering for a pitch: the open string if there is one at
 * that pitch, otherwise the *highest* string it can be reached on within seven
 * semitones (so D5 is the third finger on A, never the fifth-semitone stretch on D).
 * `undefined` above the fourth finger on the E string: those notes need a higher
 * position, which depends on the passage, so nothing is guessed.
 */
export function suggestFinger(midi: number): number | undefined {
  if (!Number.isFinite(midi)) return undefined;
  const rounded = Math.round(midi);
  for (let s = OPEN_STRING_MIDI.length - 1; s >= 0; s -= 1) {
    const above = rounded - OPEN_STRING_MIDI[s]!;
    if (above >= 0 && above < FINGER_BY_SEMITONES.length) return FINGER_BY_SEMITONES[above];
  }
  return undefined;
}

/** What to show for a practice note: the file's own finger if it wrote one, else the suggestion. */
export function fingerMarkFor(note: SequenceNote): FingerMark | undefined {
  if (note.finger !== undefined && Number.isInteger(note.finger)) {
    if (note.finger >= 0 && note.finger <= 4) return { finger: note.finger, source: 'file' };
  }
  const suggested = suggestFinger(note.note.midi);
  return suggested === undefined ? undefined : { finger: suggested, source: 'suggested' };
}

/** `fingerMarkFor` for every note, in note order (the layout wants them indexed by note). */
export function fingerMarksOf(notes: readonly SequenceNote[]): (FingerMark | undefined)[] {
  return notes.map(fingerMarkFor);
}

/** The words for a note's finger in the Letters display: "Finger 2" / "Open string"; empty when there is none. */
export function describeFinger(mark: FingerMark | undefined): string {
  if (mark === undefined) return '';
  return mark.finger === 0 ? 'Open string' : `Finger ${mark.finger}`;
}
