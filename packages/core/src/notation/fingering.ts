import type { SequenceNote } from '../sequence/sequence-generator.js';

/**
 * Violin finger numbers for ABC practice: 0 = open string, 1-4 = index to
 * little finger. They come only from the file (`!2!` before a note). The app
 * never works one out from the pitch: the finger depends on the position, and
 * a piece can shift, so a note the file leaves unmarked shows no number.
 */
export interface FingerMark {
  readonly finger: number;
}

/** What to show for a practice note: the file's own finger, or `undefined` if it wrote none. */
export function fingerMarkFor(note: SequenceNote): FingerMark | undefined {
  if (note.finger === undefined || !Number.isInteger(note.finger)) return undefined;
  return note.finger >= 0 && note.finger <= 4 ? { finger: note.finger } : undefined;
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
