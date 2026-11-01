/**
 * The *score* side of a parsed ABC tune: everything about a piece that is not
 * "which pitch" -- how long each note lasts, where the rests, bar lines, key
 * and meter changes fall, how notes are beamed and grouped in tuplets, and the
 * tempo. This is the shared contract between the ABC parser (which produces
 * it), the timed play-along engine (which turns it into a beat grid and
 * scores a performance against it) and the notation layout (which draws it).
 *
 * ## Time
 *
 * All positions and durations are in **whole notes** (a whole note = 1, a
 * quarter = 0.25, a triplet eighth = 1/12), measured from the start of the
 * chosen voice. They are plain floating-point numbers; sums of dyadic
 * fractions are exact and everything else is only ever compared with the
 * `WHOLE_EPSILON` tolerance below. Converting to milliseconds is the job of
 * the play-along plan (`../play-along/`), which is the only place a tempo
 * enters: the score itself is tempo-independent.
 *
 * ## Bars
 *
 * Bars are numbered from 0 in playing order. A bar line only starts a new bar
 * if something (a note or a rest) came since the previous one, so a leading
 * `|` or `|:`, or two bar lines in a row, never create empty bars. Repeats are
 * recognised and drawn but not expanded (the notes play once, as written).
 * A first bar shorter than the meter is a *pickup* (anacrusis): bar 0 is then
 * a partial bar and the first full bar is bar 1.
 *
 * Pure types and tiny helpers; no platform imports.
 */

import type { NoteLetter } from '../notation/note-spelling.js';
import type { SequenceNote } from '../sequence/sequence-generator.js';

/** Two durations/positions closer than this (in whole notes) are the same. Far below a 128th note (1/128 ~ 0.0078) and far above floating-point noise. */
export const WHOLE_EPSILON = 1e-9;

/** Semitone offset (-2..+2) that a key signature applies to each letter. */
export type KeyOffsets = Readonly<Record<NoteLetter, number>>;

export const NO_KEY_OFFSETS: KeyOffsets = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };

/** A time signature, with the lengths a metronome and a bar line need already worked out. */
export interface AbcMeter {
  readonly numerator: number;
  readonly denominator: number;
  /** How it is written: "4/4", "6/8", "C" (common time), "C|" (cut time). Shown by the notation as digits or the C symbol. */
  readonly display: string;
  readonly symbol: 'common' | 'cut' | undefined;
  /** Length of a full bar, in whole notes (numerator / denominator). */
  readonly barLengthWhole: number;
  /**
   * Length of one metronome beat, in whole notes: 1/denominator for simple
   * meters (4/4 -> 1/4, 3/8 -> 1/8, 2/2 -> 1/2) and 3/denominator for compound
   * ones (6/8, 9/8, 12/8 -> 3/8).
   */
  readonly beatLengthWhole: number;
  /** barLengthWhole / beatLengthWhole (4 for 4/4, 2 for 6/8, 3 for 3/4). */
  readonly beatsPerBar: number;
}

/** A tempo marking: `bpm` beats per minute, where one beat is `beatLengthWhole` of a whole note (so "1/4=120" is `{ beatLengthWhole: 0.25, bpm: 120 }`). */
export interface AbcTempoMark {
  readonly beatLengthWhole: number;
  readonly bpm: number;
  /** Text label if the file has one ("Allegro"). */
  readonly text: string | undefined;
}

export type AbcBarStyle =
  'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end' | 'repeat-both';

/** One member of a tuplet group: `actual` notes in the time of `normal` (a triplet is actual 3, normal 2). All members of a group share `id`. */
export interface AbcTuplet {
  readonly id: number;
  readonly actual: number;
  readonly normal: number;
  /** How many notes/rests the group covers. */
  readonly size: number;
  /** 0-based position of this member within the group. */
  readonly index: number;
}

export interface AbcNoteElement {
  readonly type: 'note';
  /** Index into the practice sequence / `AbcPiece.notes` (ties merged: one element per note to *play*). */
  readonly noteIndex: number;
  /** Onset, in whole notes from the start of the voice (rests and earlier notes included). */
  readonly start: number;
  /** Sounding length in whole notes, tuplets and broken rhythm applied; for a tie, the sum of its parts. */
  readonly duration: number;
  /**
   * The length as it is *written* before tuplet scaling (a triplet eighth is
   * written as an eighth: 1/8, with `duration` 1/12). The notation draws this
   * value. Equals `duration` for untied, untupleted notes.
   */
  readonly notated: number;
  /** True if no space separated this note from the previous note/rest in the source: the writer wants them beamed (when both are eighth notes or shorter). */
  readonly beamedToPrevious: boolean;
  readonly tuplet: AbcTuplet | undefined;
  /** Bar this note starts in (0-based). */
  readonly bar: number;
}

export interface AbcRestElement {
  readonly type: 'rest';
  readonly start: number;
  readonly duration: number;
  readonly notated: number;
  /** `false` for an invisible rest (`x`): takes time, is not drawn. */
  readonly visible: boolean;
  readonly beamedToPrevious: boolean;
  readonly tuplet: AbcTuplet | undefined;
  readonly bar: number;
}

export interface AbcBarElement {
  readonly type: 'bar';
  /** Position of the bar line (the end of the bar before it, the start of the next). */
  readonly at: number;
  readonly style: AbcBarStyle;
  /** Index of the bar this line *ends*; -1 for a line before any music (a leading `|:`). */
  readonly after: number;
}

/** The key signature in force from `at` on. */
export interface AbcKeyElement {
  readonly type: 'key';
  readonly at: number;
  readonly offsets: KeyOffsets;
  /** Position on the circle of fifths (sharps positive, flats negative) when the key is a standard signature; `undefined` for `exp`/extra-accidental keys. Display only. */
  readonly fifths: number | undefined;
}

export interface AbcMeterElement {
  readonly type: 'meter';
  readonly at: number;
  readonly meter: AbcMeter;
}

export interface AbcTempoElement {
  readonly type: 'tempo';
  readonly at: number;
  readonly mark: AbcTempoMark;
}

export type AbcScoreElement =
  | AbcNoteElement
  | AbcRestElement
  | AbcBarElement
  | AbcKeyElement
  | AbcMeterElement
  | AbcTempoElement;

/** The parser's output for one voice's rhythm and notation: everything in `AbcPiece` that does not depend on transposition or range. */
export interface AbcVoiceScore {
  /** Time-ordered. Starts with the header key (and meter/tempo, when the tune gives them) at position 0. */
  readonly elements: readonly AbcScoreElement[];
  readonly totalWhole: number;
  readonly barCount: number;
  readonly barStartsWhole: readonly number[];
  readonly pickupWhole: number;
}

/**
 * A practicable piece: the practice note sequence (pitches, after any
 * transposition) together with its rhythm, bars and tempo. Produced by
 * `buildAbcPracticeSequence` (its `piece` field); consumed by the play-along
 * plan and the score layout.
 */
export interface AbcPiece {
  /** The practice sequence (same objects `buildAbcPracticeSequence` returns as `notes`). `notes[i].spelling` is always set. */
  readonly notes: readonly SequenceNote[];
  /** `noteElements[i]` is the score element of `notes[i]`. */
  readonly noteElements: readonly AbcNoteElement[];
  /** Everything in time order. Starts with the key (and meter/tempo, if known) at position 0. */
  readonly elements: readonly AbcScoreElement[];
  /** Meter at the start. 4/4 when the file gives none (`meterAssumed`). */
  readonly meter: AbcMeter;
  readonly meterAssumed: boolean;
  /** Tempo at the start, as notated -- or a default when the file has none (`tempoSource`). */
  readonly tempo: AbcTempoMark;
  readonly tempoSource: 'file' | 'default';
  /** End of the last note/rest, in whole notes. */
  readonly totalWhole: number;
  /** Length of the leading partial bar in whole notes; 0 if the piece starts on a full bar. */
  readonly pickupWhole: number;
  readonly barCount: number;
  /** Start of each bar in whole notes (`barStartsWhole[0]` is 0). */
  readonly barStartsWhole: readonly number[];
  /** The key signature in force at the start. */
  readonly keyAtStart: KeyOffsets;
}

// --- Meter helpers -------------------------------------------------------------

/** Builds an `AbcMeter` from a numerator/denominator, working out the metronome beat. Throws `RangeError` on non-positive or non-integer parts. */
export function createMeter(
  numerator: number,
  denominator: number,
  symbol?: 'common' | 'cut',
): AbcMeter {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    numerator < 1 ||
    denominator < 1
  ) {
    throw new RangeError(`createMeter: invalid meter ${numerator}/${denominator}`);
  }
  const barLengthWhole = numerator / denominator;
  // Compound time (6/8, 9/8, 12/8, 6/16 ...): three small units make one beat. 3/8 is *not* compound (three eighth-note beats).
  const compound = denominator >= 8 && numerator % 3 === 0 && numerator > 3;
  const beatLengthWhole = (compound ? 3 : 1) / denominator;
  const display =
    symbol === 'common' ? 'C' : symbol === 'cut' ? 'C|' : `${numerator}/${denominator}`;
  return {
    numerator,
    denominator,
    display,
    symbol,
    barLengthWhole,
    beatLengthWhole,
    beatsPerBar: Math.round(barLengthWhole / beatLengthWhole),
  };
}

/** 4/4, assumed when a file has no `M:` line. */
export const DEFAULT_METER: AbcMeter = createMeter(4, 4);

/**
 * Tempo used when a file has no `Q:` line: a slow, learner-friendly 80
 * quarter notes per minute, expressed in the meter's own beat (so 6/8 gets a
 * dotted-quarter beat at 53, 2/2 a half-note beat at 40). Same note speed in
 * every meter; the user can change it before starting.
 */
export const DEFAULT_TEMPO_QUARTERS_PER_MINUTE = 80;

export function defaultTempoMark(meter: AbcMeter): AbcTempoMark {
  return {
    beatLengthWhole: meter.beatLengthWhole,
    bpm: Math.max(
      1,
      Math.round((DEFAULT_TEMPO_QUARTERS_PER_MINUTE * 0.25) / meter.beatLengthWhole),
    ),
    text: undefined,
  };
}

/** True if `a` and `b` (whole-note positions or durations) are the same to within `WHOLE_EPSILON`. */
export function sameWhole(a: number, b: number): boolean {
  return Math.abs(a - b) <= WHOLE_EPSILON;
}
