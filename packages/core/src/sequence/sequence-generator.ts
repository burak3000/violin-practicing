/**
 * Procedural note-sequence generator for Playing Practice.
 *
 * Confirmed decision (see temp/PLAN-violin-practice-app.md, "Confirmed
 * architectural decisions" #3): this generator is procedural, not
 * song-based. The pool is derived purely from open strings + first-position
 * major-scale patterns (see ../note/violin-strings.ts for sourcing), never
 * from sheet music or a song file.
 *
 * Practicing from sheet music was added later, at the user's explicit
 * request, as a *separate* sequence source -- see ../abc/ (an ABC-notation
 * file parsed into the same `SequenceNote[]` shape). This module stays
 * procedural; both sources feed the same session machinery.
 */

import {
  DEFAULT_A4_HZ,
  midiNumberToNoteName,
  midiToFrequencyHz,
  type NoteName,
} from '../note/note.js';
import {
  FIRST_POSITION_SEMITONE_OFFSETS,
  MAJOR_SCALE_SEMITONE_OFFSETS,
  openStringNote,
  VIOLIN_STRING_ORDER,
  type ViolinStringName,
} from '../note/violin-strings.js';

/**
 * - `open-strings`: just the open string itself.
 * - `stepwise-first-position`: open string + 1st/2nd/3rd/4th finger (major
 *   2nd/3rd, perfect 4th/5th above) — the practical first-position range.
 * - `one-octave-scale`: the full one-octave major scale starting on the
 *   open string (extends past first position on a real instrument, since a
 *   single string can't reach a full octave in first position without
 *   shifting — see violin-strings.ts's doc comment. This package generates
 *   *pitches* only, not fingerings/positions, so that's not a constraint
 *   here.)
 *
 * Note on an alternative reading considered and NOT implemented: "stepwise
 * interval drills" could instead mean an open-string call-and-response
 * pattern (open, step, open, step, ...) used for interval ear-training,
 * rather than a bounded stepwise scale walk. This implementation takes the
 * bounded-range reading (`stepwise-first-position`) because it directly
 * matches the plan's own "first-position patterns per string (roughly a
 * 4th-5th above each open string)" source-pool description one bullet
 * above the pattern-type list. Flagged in the Phase 2 report as a judgment
 * call, not a locked design.
 */
export type SequencePatternType = 'open-strings' | 'stepwise-first-position' | 'one-octave-scale';

export type SequenceDirection = 'ascending' | 'descending' | 'both';

export interface SequenceGeneratorConfig {
  /** Which open strings to draw from. Default: all four, in low-to-high (G,D,A,E) order regardless of input order. */
  readonly strings?: readonly ViolinStringName[];
  /** Default: 'stepwise-first-position'. */
  readonly patternType?: SequencePatternType;
  /** Default: 'ascending'. */
  readonly direction?: SequenceDirection;
  /** Reference pitch. Default 440. */
  readonly a4Hz?: number;
  /**
   * Overall range filter, in Hz, applied after pattern generation. Defaults
   * match packages/dsp-native's `PitchDetectorConfig::ForViolin` search
   * range (150-1600Hz) — see packages/dsp-native/CLAUDE.md's "Numbers"
   * section — so the domain layer's default practice range never asks the
   * user to play a note outside what Phase 1 empirically validated the
   * detector against.
   */
  readonly minFrequencyHz?: number;
  readonly maxFrequencyHz?: number;
}

export const DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ = 150;
export const DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ = 1600;

export interface SequenceNote {
  readonly note: NoteName;
  /** Frequency at the config's resolved a4Hz. Regenerate the sequence if a4Hz changes. */
  readonly frequencyHz: number;
  /**
   * Which open string's pattern this note was generated from. `undefined`
   * for notes that don't come from this generator (e.g. an imported ABC
   * tune, see ../abc/abc-practice.ts) -- nothing outside this module reads it.
   */
  readonly sourceString?: ViolinStringName;
}

function offsetsForPattern(patternType: SequencePatternType): readonly number[] {
  switch (patternType) {
    case 'open-strings':
      return [0];
    case 'stepwise-first-position':
      return FIRST_POSITION_SEMITONE_OFFSETS;
    case 'one-octave-scale':
      return MAJOR_SCALE_SEMITONE_OFFSETS;
    /* istanbul ignore next -- exhaustiveness guard, not a reachable runtime branch from the public API's typed inputs */
    default: {
      const exhaustive: never = patternType;
      throw new RangeError(
        `generatePlayingPracticeSequence: unknown patternType ${String(exhaustive)}`,
      );
    }
  }
}

function notesForString(
  stringName: ViolinStringName,
  patternType: SequencePatternType,
  direction: SequenceDirection,
  a4Hz: number,
): SequenceNote[] {
  const openMidi = openStringNote(stringName).midi;
  const offsets = offsetsForPattern(patternType);
  const ascendingMidis = offsets.map((offset) => openMidi + offset);

  let midis: number[];
  if (direction === 'ascending') {
    midis = ascendingMidis;
  } else if (direction === 'descending') {
    midis = [...ascendingMidis].reverse();
  } else {
    // 'both': ascend, then descend back down without repeating the top note.
    const descending = [...ascendingMidis].reverse().slice(1);
    midis = [...ascendingMidis, ...descending];
  }

  return midis.map((midi) => ({
    note: midiNumberToNoteName(midi),
    frequencyHz: midiToFrequencyHz(midi, a4Hz),
    sourceString: stringName,
  }));
}

/**
 * Generates the ordered note sequence for a Playing Practice session.
 *
 * Multi-string ordering: strings are always walked low-to-high (G, D, A, E,
 * filtered to whichever are included) regardless of the order they're
 * listed in `config.strings`; within each string, notes are ordered per
 * `direction`. This is a simple, deterministic, documented choice — not
 * something the plan specifies — so it's easy to test and easy to change
 * later without affecting the generator's public shape.
 *
 * Range filtering (`minFrequencyHz`/`maxFrequencyHz`) is applied last, over
 * the fully-assembled sequence; a note whose frequency falls outside the
 * range is dropped (not clamped). A config that filters out every note
 * returns an empty array rather than throwing — only a structurally invalid
 * config (no strings, or min > max) throws.
 */
export function generatePlayingPracticeSequence(
  config: SequenceGeneratorConfig = {},
): SequenceNote[] {
  const strings = config.strings ?? VIOLIN_STRING_ORDER;
  if (strings.length === 0) {
    throw new RangeError('generatePlayingPracticeSequence: config.strings must not be empty');
  }
  const patternType = config.patternType ?? 'stepwise-first-position';
  const direction = config.direction ?? 'ascending';
  const a4Hz = config.a4Hz ?? DEFAULT_A4_HZ;
  const minFrequencyHz = config.minFrequencyHz ?? DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ;
  const maxFrequencyHz = config.maxFrequencyHz ?? DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ;
  if (minFrequencyHz > maxFrequencyHz) {
    throw new RangeError(
      `generatePlayingPracticeSequence: minFrequencyHz (${minFrequencyHz}) must be <= maxFrequencyHz (${maxFrequencyHz})`,
    );
  }

  const includedStrings = new Set(strings);
  const orderedStrings = VIOLIN_STRING_ORDER.filter((stringName) =>
    includedStrings.has(stringName),
  );

  const notes = orderedStrings.flatMap((stringName) =>
    notesForString(stringName, patternType, direction, a4Hz),
  );

  return notes.filter((n) => n.frequencyHz >= minFrequencyHz && n.frequencyHz <= maxFrequencyHz);
}
