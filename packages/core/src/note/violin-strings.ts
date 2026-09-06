/**
 * Violin open strings and standard first-position scale content.
 *
 * Source / provenance (per Phase 2's instruction to confirm against a
 * standard first-position fingering chart rather than inventing ranges):
 *
 * - Open strings G3-D4-A4-E5, tuned in perfect fifths: this package derives
 *   their frequencies from `midiToFrequencyHz` at the configured a4Hz rather
 *   than hardcoding Hz values (matching this package's "A4 is configurable,
 *   never hardcoded past the default" rule) — at the default A4=440Hz this
 *   reproduces the plan's cited G3=196.00Hz / D4=293.66Hz / A4=440.00Hz /
 *   E5=659.25Hz exactly.
 * - First-position finger chart (checked 2026-09-05): with the standard
 *   "high 2nd finger" pattern, first position on each string covers the
 *   notes of that string's own major scale, scale degrees 1-5 (open, 1st,
 *   2nd, 3rd, 4th finger = root, major 2nd, major 3rd, perfect 4th, perfect
 *   5th above the open string) — i.e. G string: G-A-B-C-D, D string:
 *   D-E-F#-G-A, A string: A-B-C#-D-E, E string: E-F#-G#-A-B. This matches
 *   both:
 *     - Violin Lounge's first-position finger chart ("G string, A, B, C, D;
 *       ... D string E, F#, G, and A; the A string B, C#, D, and E, and the
 *       E string F#, G#, A and B") -
 *       https://violinlounge.com/article/violin-first-position-explained-with-finger-charts-notes-and-videos/
 *     - Violinspiration's one-octave-scale-per-string method material (e.g.
 *       "[g major scale] begins on the open G string ... G, A, B, C, D, E,
 *       and F#") - https://violinspiration.com/violin-g-major-scale/ ,
 *       https://violinspiration.com/violin-a-major-scale/
 *   i.e. each string's "first position range" is exactly the bottom half of
 *   that string's one-octave major scale (degrees 1-5 of 8), and the
 *   "roughly a 4th-5th above" language in the plan corresponds to the 3rd
 *   finger (perfect 4th, e.g. C4 on the G string) and 4th finger (perfect
 *   5th, e.g. D4 on the G string) respectively. This package does not model
 *   *which* physical string a note is fingered on (pitch detection is
 *   monophonic Hz-in, note-out — see root CLAUDE.md's "Pitch detection is
 *   monophonic" scope note) — "per string" here just names which major
 *   scale a group of generated notes is drawn from, matching how these
 *   scales are actually named in method books ("the G major scale", "the D
 *   major scale", ...).
 */

import { midiToFrequencyHz, parseNoteName, type NoteName } from './note.js';

export type ViolinStringName = 'G' | 'D' | 'A' | 'E';

/** Canonical low-to-high ordering, used everywhere a fixed iteration order over strings is needed. */
export const VIOLIN_STRING_ORDER: readonly ViolinStringName[] = ['G', 'D', 'A', 'E'];

/** Open-string note names in scientific pitch notation. */
export const OPEN_STRING_NOTE_NAMES: Readonly<Record<ViolinStringName, string>> = {
  G: 'G3',
  D: 'D4',
  A: 'A4',
  E: 'E5',
};

const OPEN_STRING_NOTES: Readonly<Record<ViolinStringName, NoteName>> = Object.fromEntries(
  VIOLIN_STRING_ORDER.map((stringName) => {
    const note = parseNoteName(OPEN_STRING_NOTE_NAMES[stringName]);
    /* istanbul ignore if -- OPEN_STRING_NOTE_NAMES above are fixed, known-valid literals */
    if (note === undefined) {
      throw new Error(`violin-strings: invalid built-in open string note name for ${stringName}`);
    }
    return [stringName, note];
  }),
) as Readonly<Record<ViolinStringName, NoteName>>;

/** The open string's exact `NoteName` (tuning-independent: MIDI/pitch-class/octave). */
export function openStringNote(stringName: ViolinStringName): NoteName {
  return OPEN_STRING_NOTES[stringName];
}

/** The open string's frequency at the given a4Hz (default 440). */
export function openStringFrequencyHz(stringName: ViolinStringName, a4Hz?: number): number {
  return midiToFrequencyHz(OPEN_STRING_NOTES[stringName].midi, a4Hz);
}

/**
 * Semitone offsets from the open string, for the standard major scale
 * starting on that string (root, M2, M3, P4, P5, M6, M7, octave) — see the
 * module doc comment for sourcing. Index 4 (perfect 5th, offset 7) is the
 * top of "first position range"; the full array is one octave.
 */
export const MAJOR_SCALE_SEMITONE_OFFSETS: readonly number[] = [0, 2, 4, 5, 7, 9, 11, 12];

/** Offsets covering just the practical first-position range (open string through the 4th-5th above). */
export const FIRST_POSITION_SEMITONE_OFFSETS: readonly number[] =
  MAJOR_SCALE_SEMITONE_OFFSETS.slice(0, 5);
