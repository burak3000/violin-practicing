/**
 * Hz <-> note name <-> cents-off-target utilities.
 *
 * This is the TypeScript-side equivalent of packages/dsp-native's
 * `note_utils.h/.cpp` — same domain (equal-tempered note math, scientific
 * pitch notation, cents), independently implemented per Phase 2's scope
 * (packages/core has no dependency on packages/dsp-native; the two are
 * consumed differently by each platform and are not bound together). The
 * conventions below (sharps-only canonical spelling, MIDI 69 == A4, C4 ==
 * "middle C" == MIDI 60) deliberately match dsp-native's so the two sides
 * of the app agree on what a given frequency is *called*, even though nothing
 * here links to that C++ code.
 *
 * Reference pitch (A4) is a parameter everywhere, defaulting to 440Hz but
 * never hardcoded past that default — some players/orchestras tune to A442
 * or similar, so every function here accepts an `a4Hz` override.
 */

/** Standard concert pitch. Configurable everywhere below, not a locked constant. */
export const DEFAULT_A4_HZ = 440;

/** Canonical pitch-class spelling, sharps only (index 0 == C), matching dsp-native's `note_utils.cpp`. */
export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export type PitchClassName = (typeof PITCH_CLASS_NAMES)[number];

/** A fully-resolved, tuning-independent note identity (MIDI number is exact regardless of a4Hz). */
export interface NoteName {
  readonly pitchClass: PitchClassName;
  /** Scientific-pitch-notation octave; C4 is "middle C". */
  readonly octave: number;
  /** Integer MIDI note number. A4 == 69 by definition, independent of a4Hz. */
  readonly midi: number;
  /** Convenience formatted label, e.g. "C#4", "G3". */
  readonly label: string;
}

/**
 * midiNote 69 == A4 == a4Hz. Standard equal-tempered mapping.
 * `midiNote` need not be an integer (useful for exact/fractional pitch math);
 * see `midiNumberToNoteName` for snapping to the nearest named note.
 */
export function midiToFrequencyHz(midiNote: number, a4Hz: number = DEFAULT_A4_HZ): number {
  return a4Hz * 2 ** ((midiNote - 69) / 12);
}

/** Inverse of `midiToFrequencyHz`. `frequencyHz` must be > 0. Result may be fractional. */
export function frequencyHzToMidi(frequencyHz: number, a4Hz: number = DEFAULT_A4_HZ): number {
  if (!(frequencyHz > 0)) {
    throw new RangeError(`frequencyHzToMidi: frequencyHz must be > 0, got ${frequencyHz}`);
  }
  return 69 + 12 * Math.log2(frequencyHz / a4Hz);
}

/**
 * cents = 1200 * log2(frequencyHz / referenceHz). Positive => sharp of the
 * reference, negative => flat. Both arguments must be > 0.
 */
export function frequencyToCents(frequencyHz: number, referenceHz: number): number {
  if (!(frequencyHz > 0) || !(referenceHz > 0)) {
    throw new RangeError(
      `frequencyToCents: both arguments must be > 0, got frequencyHz=${frequencyHz}, referenceHz=${referenceHz}`,
    );
  }
  return 1200 * Math.log2(frequencyHz / referenceHz);
}

/**
 * Resolves an integer MIDI note number (rounding if given a fractional one)
 * to its canonical (sharps-only) name. Does not know or care about cents
 * offset — see `analyzeFrequency` for "what note is this frequency nearest
 * to, and by how many cents."
 */
export function midiNumberToNoteName(midiNumber: number): NoteName {
  const midi = Math.round(midiNumber);
  const pitchClassIndex = ((midi % 12) + 12) % 12;
  const pitchClass = PITCH_CLASS_NAMES[pitchClassIndex];
  const octave = Math.floor(midi / 12) - 1;
  return { pitchClass, octave, midi, label: `${pitchClass}${octave}` };
}

/** The result of asking "what note is this frequency nearest to, and how far off is it?" */
export interface FrequencyAnalysis {
  readonly note: NoteName;
  /** Signed cents offset from `note`'s exact equal-tempered pitch. Positive => sharp, negative => flat. */
  readonly cents: number;
}

/** Nearest-note analysis, referenced to a4Hz. E.g. 445Hz with a4Hz=440 => A4, +19.6c. */
export function analyzeFrequency(
  frequencyHz: number,
  a4Hz: number = DEFAULT_A4_HZ,
): FrequencyAnalysis {
  const midiFloat = frequencyHzToMidi(frequencyHz, a4Hz);
  const nearestMidi = Math.round(midiFloat);
  const cents = (midiFloat - nearestMidi) * 100;
  return { note: midiNumberToNoteName(nearestMidi), cents };
}

/** Convenience: just the cents offset from `analyzeFrequency` (nearest-note, not a specific target). */
export function centsOffNearestNote(frequencyHz: number, a4Hz: number = DEFAULT_A4_HZ): number {
  return analyzeFrequency(frequencyHz, a4Hz).cents;
}

// [A-G] then optional '#' (sharp) or 'b' (flat, lowercase only, to avoid
// ambiguity with the 'B' natural note letter), then an integer octave.
// Matches dsp-native's ParseScientificPitchToHz pattern exactly.
const NOTE_NAME_PATTERN = /^([A-Ga-g])([#b]?)(-?\d+)$/;

const BASE_PITCH_CLASS_BY_LETTER: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * Parses scientific pitch notation (e.g. "G3", "Bb4", "C#5", "Db6") into a
 * tuning-independent `NoteName`. Returns undefined if `name` doesn't parse.
 * The MIDI number (and therefore Hz, via `midiToFrequencyHz`) does not
 * depend on a4Hz — only converting the resolved note *to* Hz does, which is
 * why this function takes no a4Hz parameter; see `noteNameToFrequencyHz`
 * for the combined convenience.
 *
 * Note this "canonicalizes" flat spellings to their sharp equivalent in the
 * returned NoteName's label (e.g. parsing "Bb4" returns pitchClass "A#",
 * label "A#4") — this package only ever displays sharps, matching
 * dsp-native's convention.
 */
export function parseNoteName(name: string): NoteName | undefined {
  const match = NOTE_NAME_PATTERN.exec(name.trim());
  if (!match) {
    return undefined;
  }
  const letter = match[1]!.toUpperCase();
  const basePitchClass = BASE_PITCH_CLASS_BY_LETTER[letter];
  if (basePitchClass === undefined) {
    return undefined;
  }
  let pitchClassIndex = basePitchClass;
  if (match[2] === '#') {
    pitchClassIndex += 1;
  } else if (match[2] === 'b') {
    pitchClassIndex -= 1;
  }
  const octave = Number.parseInt(match[3]!, 10);
  // Scientific pitch notation: MIDI = (octave + 1) * 12 + pitchClass, so
  // C4 ("middle C") == MIDI 60. Deliberately do NOT wrap pitchClassIndex into
  // [0, 11] here first — it can be -1 (e.g. "Cb") or 12 (e.g. "B#"), and the
  // octave has to carry across that wrap too (Cb4 == B3, not B4). Computing
  // midi directly from the raw index and letting midiNumberToNoteName derive
  // the canonical pitch class *and* octave from the final midi value handles
  // that correctly; wrapping pitchClassIndex first would silently drop the
  // octave carry.
  const midi = (octave + 1) * 12 + pitchClassIndex;
  return midiNumberToNoteName(midi);
}

/** Convenience: parse a note name and resolve it directly to Hz at the given a4Hz. Returns undefined if `name` doesn't parse. */
export function noteNameToFrequencyHz(
  name: string,
  a4Hz: number = DEFAULT_A4_HZ,
): number | undefined {
  const note = parseNoteName(name);
  return note === undefined ? undefined : midiToFrequencyHz(note.midi, a4Hz);
}

/** Human-readable "NoteName +/-cents" label, e.g. "A4 -3c", "(no pitch)" for non-positive input. For logging/debug display only. */
export function describeFrequency(frequencyHz: number, a4Hz: number = DEFAULT_A4_HZ): string {
  if (!(frequencyHz > 0)) {
    return '(no pitch)';
  }
  const { note, cents } = analyzeFrequency(frequencyHz, a4Hz);
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${note.label} ${sign}${Math.abs(rounded)}c`;
}
