/**
 * ABC notation parser: ABC text -> the ordered list of pitches a violinist
 * would play, for ABC Notation practice mode.
 *
 * ## Scope: pitch only, and honest about what it skips
 *
 * Practice mode scores *pitch* (does the user hold the target note in tune
 * long enough), exactly like the scale/arpeggio modes -- it does not score
 * rhythm. So this parser resolves, with full correctness, everything that
 * decides *which pitch* a written note is:
 *
 * - the note letter, octave marks (`'` `,`), and case (`C` = C4, `c` = C5);
 * - explicit accidentals (`^` `^^` `_` `__` `=`) and their scope: they last
 *   until the end of the bar, for the same letter *and octave*. That is
 *   standard printed notation's rule and what abcjs (the renderer behind
 *   most ABC sites) does, i.e. what the player sees on the sheet. The ABC
 *   2.1 standard's own default (`%%propagate-accidentals pitch`, in a
 *   section it marks volatile) would carry an accidental to that letter in
 *   *every* octave; this parser deliberately does not;
 * - the key signature (`K:`, including modes -- `Ador`, `Gmix`, `Bm`... --
 *   explicit `exp` accidentals, `HP`/`Hp`), in the header and mid-tune via a
 *   `K:` line or an inline `[K:...]`;
 * - ties (`-`): tied notes are one note to play, not two, and an accidental
 *   carries across a tie into the next bar;
 * - voices (`V:`): each voice's notes are kept separate so a multi-voice
 *   score doesn't get its parts interleaved.
 *
 * Rhythm is kept too (it drives the timed play-along and the notation): each
 * note's length (`2`, `/2`, `3/2`, `//`, broken rhythm `>`/`<`, tuplets
 * `(3` / `(p:q:r`, ties summed), rests (`z`, `x`, multi-bar `Z`), bar lines
 * and their style, the meter (`M:`), unit note length (`L:`), tempo (`Q:`)
 * and mid-tune changes to any of them, and which notes the writer beamed
 * together (no space between them). All of it is returned as a time-ordered
 * list of score elements per voice (`AbcVoice.score`, see `./abc-score.ts`)
 * with positions in whole notes. Rests take their time but are not practice
 * notes. Grace notes take no time.
 *
 * Things that *would* change what the player has to play but that this
 * parser can't represent are never silently mis-parsed -- each produces an
 * entry in the tune's `warnings`:
 *
 * - chords / double stops (`[CEG]`): monophonic app, so the top note is used;
 * - microtonal accidentals (`^/`, `_3/2`): treated as the plain semitone sign;
 * - voice overlays (`&`): the overlaid notes are skipped;
 * - macros (`m:`): not expanded;
 * - ties between different pitches, unterminated chords, characters it can't
 *   interpret, a bad/unknown key, notes after a blank line (which ends a
 *   tune in ABC).
 *
 * Repeats (`|:` `:|`, first/second endings) are recognized as bar lines and
 * not expanded: the notes are played once, as written.
 *
 * Pure TypeScript, zero DOM/Node/React-Native imports, like everything else
 * in this package. Never throws: bad input yields fewer/no tunes plus
 * warnings.
 */

import type { NoteSpelling } from '../notation/note-spelling.js';
import {
  DEFAULT_METER,
  WHOLE_EPSILON,
  createMeter,
  type AbcBarStyle,
  type AbcMeter,
  type AbcScoreElement,
  type AbcTempoMark,
  type AbcTuplet,
  type AbcVoiceScore,
  type KeyOffsets,
} from './abc-score.js';

/** `!3!`-style fingering decoration: the digit 0 (open string) to 4, else `undefined` (every other decoration). */
function fingerOfDecoration(text: string): number | undefined {
  return /^[0-4]$/.test(text) ? Number(text) : undefined;
}

/** Hard cap on input size (characters). An ABC tune book is a few hundred KB at the very most; anything bigger is almost certainly not an ABC file, and refusing it up front keeps a wrong-file pick from hanging a UI thread. */
export const MAX_ABC_TEXT_LENGTH = 1_000_000;

export interface AbcVoice {
  /** The `V:` identifier, or `''` for a tune that doesn't use voices. */
  readonly id: string;
  /** `name="..."` / `nm="..."` from the `V:` field, if given. */
  readonly name: string | undefined;
  /** MIDI note numbers in playing order (ties merged, rests dropped, chords reduced to their top note). */
  readonly notes: readonly number[];
  /** How each note is written (letter, accidental, octave), parallel to `notes` -- B-flat stays B-flat -- for drawing it on a staff. */
  readonly spellings: readonly NoteSpelling[];
  /**
   * The violin finger the file writes for each note (`!1!`...`!4!`, `!0!` for an open string), parallel
   * to `notes`; `undefined` where it writes none. A tied note keeps the first part's number.
   */
  readonly fingers: readonly (number | undefined)[];
  /** Rhythm and notation: every note (as an element pointing back into `notes` by index), rest, bar line and key/meter/tempo change, in time order. */
  readonly score: AbcVoiceScore;
}

export interface AbcTune {
  /** 0-based position of this tune within the file. */
  readonly index: number;
  /** The `X:` reference number as written, if any. */
  readonly referenceNumber: string | undefined;
  /** First `T:` title; `''` if the tune has none. */
  readonly title: string;
  readonly composer: string | undefined;
  /** The header `K:` value as written (e.g. `"G"`, `"Ador"`), `''` if absent. For display only. */
  readonly key: string;
  /** The header `M:` meter; `undefined` if the tune gives none (or `M:none`, free meter). */
  readonly meter: AbcMeter | undefined;
  /** The header `Q:` tempo; `undefined` if the tune gives none (or only a text like `Q:"Allegro"`). */
  readonly tempo: AbcTempoMark | undefined;
  /** The `L:` unit note length in force at the start of the music, in whole notes (1/8 -> 0.125): explicit, or ABC's default from the meter. */
  readonly unitNoteLength: number;
  /** Always at least one voice. Voices appear in order of first mention; voices that never got a note are omitted unless that would leave none. */
  readonly voices: readonly AbcVoice[];
  readonly warnings: readonly string[];
}

export interface AbcParseResult {
  readonly tunes: readonly AbcTune[];
  /** File-level problems (no tunes found, file too large, text outside any tune). Per-tune problems are on each tune. */
  readonly warnings: readonly string[];
}

// --- Pitch tables -------------------------------------------------------

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
type LetterOffsets = Record<Letter, number>;

const LETTER_SEMITONES: Readonly<Record<Letter, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Order in which sharps are added to a key signature, then flats. */
const SHARP_ORDER: readonly Letter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: readonly Letter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Position on the circle of fifths (sharps count; negative = flats) of each *major* key's tonic letter, before any `#`/`b`. */
const MAJOR_FIFTHS: Readonly<Record<Letter, number>> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  F: -1,
};

/** How far a mode moves the key signature from its parallel major's, keyed by the mode name's first three letters (lowercased). */
const MODE_FIFTHS_SHIFT: Readonly<Record<string, number>> = {
  maj: 0,
  ion: 0,
  min: -3,
  aeo: -3,
  mix: -1,
  dor: -2,
  phr: -4,
  lyd: 1,
  loc: -5,
};

/** More than two sharps/flats on one letter (beyond +-14 on the circle of fifths) can't be written. */
const MAX_ABS_FIFTHS = 14;

function modeShiftFor(word: string): number | undefined {
  const lower = word.toLowerCase();
  if (lower === 'm') return MODE_FIFTHS_SHIFT.min;
  return MODE_FIFTHS_SHIFT[lower.slice(0, 3)];
}

function emptyOffsets(): LetterOffsets {
  return { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
}

/** Per-letter semitone offsets for a key signature `fifths` steps around the circle (sharps positive, flats negative). Works past +-7 (double sharps/flats) so exotic keys like G# major still read their letters correctly. */
function offsetsForFifths(fifths: number): LetterOffsets {
  const offsets = emptyOffsets();
  if (fifths > 0) {
    SHARP_ORDER.forEach((letter, position) => {
      offsets[letter] = Math.floor((fifths - position + 6) / 7);
    });
  } else if (fifths < 0) {
    FLAT_ORDER.forEach((letter, position) => {
      offsets[letter] = 0 - Math.floor((-fifths - position + 6) / 7); // `0 -` (not unary minus) so an unaltered letter is +0, never -0
    });
  }
  return offsets;
}

const KEY_ACCIDENTAL_TOKEN = /^(__|_|=|\^\^|\^)([A-Ga-g])$/;

/** Words that may follow the tonic in a `K:` field and mean something other than a mode (so they're never reported as an unknown key). */
const KEY_IGNORED_TOKEN =
  /^(exp|explicit|clef|treble|bass|alto|tenor|perc|none|stafflines|middle|transpose|octave|style|staffscale|[a-z-]+=.*)/i;

interface ParsedKey {
  readonly offsets: LetterOffsets;
  /** Position on the circle of fifths when the key is a plain signature (no `exp`, no extra accidentals); otherwise `undefined`. Display only. */
  readonly fifths: number | undefined;
  readonly warnings: readonly string[];
}

/** Parses the value of a `K:` field (or inline `[K:...]`) into per-letter offsets. */
function parseKeyField(raw: string): ParsedKey {
  const warnings: string[] = [];
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  let fifths = 0;
  let explicit = false;
  const accidentals: Array<readonly [Letter, number]> = [];
  let consumedFirst = false;

  const first = tokens[0];
  if (first !== undefined) {
    if (first === 'HP' || first === 'Hp') {
      // Highland bagpipe keys: played as D major (F#, C#); HP just doesn't print the signature.
      fifths = 2;
      consumedFirst = true;
    } else if (/^none$/i.test(first)) {
      consumedFirst = true;
    } else {
      const match = /^([A-Ga-g])([#b]?)(.*)$/.exec(first);
      if (match) {
        const letter = match[1]!.toUpperCase() as Letter;
        const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
        let modeShift = 0;
        const attachedMode = match[3]!;
        if (attachedMode.length > 0) {
          const shift = modeShiftFor(attachedMode);
          if (shift === undefined) {
            warnings.push(`Unknown mode "${attachedMode}" in key "${raw}"; assuming major.`);
          } else {
            modeShift = shift;
          }
        } else {
          const second = tokens[1];
          if (second !== undefined) {
            const shift = modeShiftFor(second);
            if (shift !== undefined) {
              modeShift = shift;
              tokens.splice(1, 1);
            }
          }
        }
        fifths = MAJOR_FIFTHS[letter] + 7 * accidental + modeShift;
        consumedFirst = true;
      }
    }
  }

  for (const token of tokens.slice(consumedFirst ? 1 : 0)) {
    if (token === 'exp' || token === 'explicit') {
      explicit = true;
      continue;
    }
    const accidentalMatch = KEY_ACCIDENTAL_TOKEN.exec(token);
    if (accidentalMatch) {
      const sign = accidentalMatch[1]!;
      const value =
        sign === '^^' ? 2 : sign === '^' ? 1 : sign === '=' ? 0 : sign === '_' ? -1 : -2;
      accidentals.push([accidentalMatch[2]!.toUpperCase() as Letter, value]);
      continue;
    }
    if (!consumedFirst && token === tokens[0] && !KEY_IGNORED_TOKEN.test(token)) {
      warnings.push(`Unrecognized key "${raw}"; assuming no key signature.`);
    }
  }

  if (Math.abs(fifths) > MAX_ABS_FIFTHS) {
    warnings.push(`Key "${raw}" needs more sharps/flats than can be written; assuming none.`);
    fifths = 0;
  }

  const offsets = explicit ? emptyOffsets() : offsetsForFifths(fifths);
  for (const [letter, value] of accidentals) {
    offsets[letter] = value;
  }
  return { offsets, fifths: explicit || accidentals.length > 0 ? undefined : fifths, warnings };
}

// --- Meter, unit note length, tempo, note lengths -------------------------------

/** Largest numerator or denominator accepted in a time signature; anything bigger is a typo and would make the bar-length arithmetic meaningless. */
const MAX_METER_PART = 64;

/**
 * Parses an `M:` value: `4/4`, `3/8`, `C` (4/4), `C|` (2/2), `(2+3+2)/8` or
 * `2+3/8` (summed), `none` (free meter). Returns `{ meter: undefined }` for
 * `none` and for anything unrecognized (the latter with a warning).
 */
function parseMeterField(raw: string): { meter: AbcMeter | undefined; warning?: string } {
  const text = raw.trim();
  if (text === '' || /^none$/i.test(text)) return { meter: undefined };
  if (text === 'C') return { meter: createMeter(4, 4, 'common') };
  if (text === 'C|') return { meter: createMeter(2, 2, 'cut') };

  const match = /^\(?\s*([\d+\s]+?)\s*\)?\s*\/\s*(\d+)\s*$/.exec(text);
  if (match) {
    const numerator = match[1]!
      .split('+')
      .map((part) => Number.parseInt(part.trim(), 10))
      .reduce((sum, part) => sum + part, 0);
    const denominator = Number.parseInt(match[2]!, 10);
    if (
      Number.isInteger(numerator) &&
      numerator >= 1 &&
      numerator <= MAX_METER_PART &&
      denominator >= 1 &&
      denominator <= MAX_METER_PART
    ) {
      return { meter: createMeter(numerator, denominator) };
    }
  }
  return {
    meter: undefined,
    warning: `Unrecognized meter "${text}" (M:); treating it as no meter.`,
  };
}

/** Parses a fraction like `1/8` (or a bare integer) into whole notes. Returns `undefined` for anything else or for zero. */
function parseFraction(text: string): number | undefined {
  const match = /^(\d+)(?:\s*\/\s*(\d+))?$/.exec(text.trim());
  if (!match) return undefined;
  const numerator = Number.parseInt(match[1]!, 10);
  const denominator = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  if (!(numerator > 0) || !(denominator > 0)) return undefined;
  return numerator / denominator;
}

/** ABC's default unit note length for a meter: 1/16 below 3/4 (meter value < 0.75), otherwise 1/8; 1/8 with no meter. */
function defaultUnitLength(meter: AbcMeter | undefined): number {
  if (meter === undefined) return 1 / 8;
  return meter.barLengthWhole < 0.75 ? 1 / 16 : 1 / 8;
}

/**
 * Parses a `Q:` value: `1/4=120`, `"Allegro" 1/4=120`, `1/4=120 "Allegro"`,
 * `3/8=50`, `C=120` (old style), several lengths summed (`1/4 3/8 1/4 3/8=40`),
 * `ca. 1/4=120`, or a bare number (`Q:120`), which -- as abcjs does -- counts
 * notes of the meter's 1/denominator length (a quarter in 4/4, an eighth in
 * 6/8). A text-only `Q:"Andante"` has no number: `{ mark: undefined }`.
 */
function parseTempoField(
  raw: string,
  meter: AbcMeter | undefined,
): { mark: AbcTempoMark | undefined; warning?: string } {
  const text = raw.trim();
  const quoted = /"([^"]*)"/.exec(text);
  const label = quoted ? quoted[1]!.trim() || undefined : undefined;
  const rest = text
    .replace(/"[^"]*"/g, ' ')
    .replace(/\bca\.?/gi, ' ')
    .trim();
  if (rest === '') return { mark: undefined };

  let beatLengthWhole: number;
  let bpmText: string;
  const equals = rest.indexOf('=');
  if (equals >= 0) {
    bpmText = rest.slice(equals + 1).trim();
    const lengths = rest
      .slice(0, equals)
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .map((part) => (part === 'C' ? 1 / 4 : parseFraction(part)));
    if (lengths.length === 0 || lengths.some((length) => length === undefined)) {
      return { mark: undefined, warning: `Unrecognized tempo "${text}" (Q:); ignoring it.` };
    }
    beatLengthWhole = lengths.reduce<number>((sum, length) => sum + length!, 0);
  } else {
    bpmText = rest;
    beatLengthWhole = 1 / (meter?.denominator ?? 4);
  }

  const bpm = Number.parseFloat(bpmText);
  if (!/^\d+(\.\d+)?$/.test(bpmText) || !(bpm > 0) || !(bpm <= MAX_TEMPO_BPM)) {
    return { mark: undefined, warning: `Unrecognized tempo "${text}" (Q:); ignoring it.` };
  }
  return { mark: { beatLengthWhole, bpm, text: label } };
}

/** A tempo above this is a typo (or a different field); refusing it keeps the timeline from collapsing to nothing. */
const MAX_TEMPO_BPM = 1000;

/** Longest and shortest length multiplier a single note may carry; beyond it the length is almost certainly a typo, and it keeps the timeline sane. */
const MAX_LENGTH_MULTIPLIER = 128;
const MIN_LENGTH_MULTIPLIER = 1 / 128;

/**
 * Reads a note length at `from`: `2`, `/2`, `3/2`, `/` (= /2), `//` (= /4),
 * `3/` (= 3/2), `/3`. Returns the multiplier of the unit note length, where
 * the text ended, and whether it was unusable (`0`, `/0`, or out of the
 * sane range) -- in which case the multiplier is 1 (or the clamped value).
 */
function readLength(
  s: string,
  from: number,
): { multiplier: number; end: number; invalid: boolean } {
  let j = from;
  let numeratorText = '';
  while (isDigit(s[j])) {
    numeratorText += s[j];
    j += 1;
  }
  const numerator = numeratorText === '' ? 1 : Number.parseInt(numeratorText, 10);
  let denominator = 1;
  if (s[j] === '/') {
    let slashes = 0;
    while (s[j] === '/') {
      slashes += 1;
      j += 1;
    }
    if (slashes === 1 && isDigit(s[j])) {
      let denominatorText = '';
      while (isDigit(s[j])) {
        denominatorText += s[j];
        j += 1;
      }
      denominator = Number.parseInt(denominatorText, 10);
    } else {
      denominator = 2 ** slashes;
    }
  }
  if (!(numerator > 0) || !(denominator > 0)) {
    return { multiplier: 1, end: j, invalid: true };
  }
  let multiplier = numerator / denominator;
  let invalid = false;
  if (multiplier > MAX_LENGTH_MULTIPLIER) {
    multiplier = MAX_LENGTH_MULTIPLIER;
    invalid = true;
  } else if (multiplier < MIN_LENGTH_MULTIPLIER) {
    multiplier = MIN_LENGTH_MULTIPLIER;
    invalid = true;
  }
  return { multiplier, end: j, invalid };
}

// --- Bar lines and the score ----------------------------------------------------

/** What a run of bar-line characters (`|`, `||`, `|]`, `[|`, `|:`, `:|`, `:|:`, `::`) draws as. */
function barStyleOf(token: string): AbcBarStyle {
  const startsWithColon = token.startsWith(':');
  const endsWithColon = token.endsWith(':');
  if (startsWithColon && endsWithColon && token.length > 1) return 'repeat-both';
  if (startsWithColon && token.length > 1) return 'repeat-end';
  if (endsWithColon && token.length > 1) return 'repeat-start';
  if (token.endsWith(']')) return 'final';
  if (token.startsWith('[') || token.length > 1) return 'double';
  return 'single';
}

const BAR_STYLE_RANK: Readonly<Record<AbcBarStyle, number>> = {
  single: 0,
  double: 1,
  'repeat-start': 2,
  'repeat-end': 2,
  'repeat-both': 2,
  final: 3,
};

/** Two bar lines with nothing between them (`:| |:`) are drawn as one: end+start repeats combine, otherwise the heavier line wins. */
function mergeBarStyles(first: AbcBarStyle, second: AbcBarStyle): AbcBarStyle {
  if (
    (first === 'repeat-end' && second === 'repeat-start') ||
    (first === 'repeat-start' && second === 'repeat-end')
  ) {
    return 'repeat-both';
  }
  return BAR_STYLE_RANK[second] >= BAR_STYLE_RANK[first] ? second : first;
}

/**
 * The length of a note from all its written parts. The written (`notated`)
 * length and the tuplet are kept only while every part belongs to the same
 * tuplet group (or none); a tie between a triplet note and a plain one has no
 * single written value, so it is described by its sounding length alone.
 */
function combinePieces(pieces: readonly Piece[]): {
  duration: number;
  notated: number;
  tuplet: AbcTuplet | undefined;
} {
  const first = pieces[0]!;
  let duration = 0;
  let notated = 0;
  let sameGroup = true;
  for (const piece of pieces) {
    duration += piece.duration;
    notated += piece.notated;
    if (piece.tuplet?.id !== first.tuplet?.id) sameGroup = false;
  }
  return sameGroup
    ? { duration, notated, tuplet: first.tuplet }
    : { duration, notated: duration, tuplet: undefined };
}

/**
 * Turns one voice's parse events into score elements: assigns every note and
 * rest its start (the running total of earlier durations) and bar, numbers the
 * bars (a bar line only closes a bar if music came since the last one), and
 * notes a leading partial bar as a pickup.
 */
function buildVoiceScore(events: readonly ParsedEvent[], meterAtStart: AbcMeter): AbcVoiceScore {
  const elements: AbcScoreElement[] = [];
  const barStarts: number[] = [0];
  let position = 0;
  let bar = 0;
  let hasContent = false;
  let lastBarIndex: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'note': {
        const { duration, notated, tuplet } = combinePieces(event.pieces);
        elements.push({
          type: 'note',
          noteIndex: event.noteIndex,
          start: position,
          duration,
          notated,
          beamedToPrevious: event.beamed,
          tuplet,
          bar,
        });
        position += event.pieces[0]!.duration;
        hasContent = true;
        lastBarIndex = undefined;
        break;
      }
      case 'tie':
        // The later part of a tied note: time passes (a bar line may follow it in the next bar), nothing new starts.
        position += event.note.pieces[event.part]!.duration;
        hasContent = true;
        lastBarIndex = undefined;
        break;
      case 'rest': {
        const { duration, notated, tuplet } = combinePieces(event.pieces);
        elements.push({
          type: 'rest',
          start: position,
          duration,
          notated,
          visible: event.visible,
          beamedToPrevious: event.beamed,
          tuplet,
          bar,
        });
        position += duration;
        hasContent = true;
        lastBarIndex = undefined;
        break;
      }
      case 'bar': {
        if (hasContent) {
          elements.push({ type: 'bar', at: position, style: event.style, after: bar });
          lastBarIndex = elements.length - 1;
          bar += 1;
          barStarts.push(position);
          hasContent = false;
        } else if (lastBarIndex !== undefined) {
          const previous = elements[lastBarIndex] as Extract<AbcScoreElement, { type: 'bar' }>;
          elements[lastBarIndex] = {
            ...previous,
            style: mergeBarStyles(previous.style, event.style),
          };
        } else {
          // A bar line before any music (a leading `|:`).
          elements.push({ type: 'bar', at: position, style: event.style, after: bar - 1 });
          lastBarIndex = elements.length - 1;
        }
        break;
      }
      case 'key':
        elements.push({ type: 'key', at: position, offsets: event.offsets, fifths: event.fifths });
        break;
      case 'meter':
        elements.push({ type: 'meter', at: position, meter: event.meter });
        break;
      case 'tempo':
        elements.push({ type: 'tempo', at: position, mark: event.mark });
        break;
    }
  }

  const barCount = bar + (hasContent ? 1 : 0);
  const firstBarEnd = barStarts[1];
  const pickupWhole =
    barCount > 1 &&
    firstBarEnd !== undefined &&
    firstBarEnd < meterAtStart.barLengthWhole - WHOLE_EPSILON
      ? firstBarEnd
      : 0;
  return {
    elements,
    totalWhole: position,
    barCount,
    barStartsWhole: barStarts.slice(0, barCount),
    pickupWhole,
  };
}

/** Indices of the bars (0-based) whose length is not the meter's, ignoring the first and last bar (a pickup and the bar that completes it) and bars next to a repeat, double or final line (where sections and endings legitimately end short). */
function irregularBars(score: AbcVoiceScore, meter: AbcMeter): number[] {
  const barLines = new Map<number, AbcBarStyle>();
  for (const element of score.elements) {
    if (element.type === 'bar') barLines.set(element.after, element.style);
  }
  const irregular: number[] = [];
  for (let bar = 1; bar < score.barCount - 1; bar += 1) {
    const length = (score.barStartsWhole[bar + 1] ?? score.totalWhole) - score.barStartsWhole[bar]!;
    if (Math.abs(length - meter.barLengthWhole) <= 1e-6) continue;
    const closing = barLines.get(bar);
    const opening = barLines.get(bar - 1);
    if (closing !== undefined && closing !== 'single') continue;
    if (opening !== undefined && opening !== 'single') continue;
    irregular.push(bar);
  }
  return irregular;
}

// --- Per-tune parse state ------------------------------------------------

interface LastNote {
  readonly letter: Letter;
  readonly octave: number;
  readonly offset: number;
  readonly midi: number;
  /** A finger decoration (`!2!`) written for this note, if any. */
  readonly finger?: number | undefined;
}

/**
 * One written part of a note or rest. A tied note has several, and each sits
 * at its own place in time -- a tie across a bar line puts a bar line *between*
 * the parts, so the parts are separate time-advancing events (`tie` below) and
 * only the finished note adds them up. Mutable on purpose: broken rhythm
 * adjusts the last part of the previous element after the fact.
 */
interface Piece {
  duration: number;
  notated: number;
  tuplet: AbcTuplet | undefined;
}

interface ParsedNote {
  readonly type: 'note';
  /** Index into the voice's `notes` / `spellings`. */
  readonly noteIndex: number;
  readonly beamed: boolean;
  /** The first part, then one per tie. */
  readonly pieces: Piece[];
}

interface ParsedRest {
  readonly type: 'rest';
  readonly visible: boolean;
  readonly beamed: boolean;
  readonly pieces: Piece[];
}

type ParsedEvent =
  | ParsedNote
  | ParsedRest
  /** A tie's later part: time passes here (so bar lines after it fall in the right place), but no new note starts. */
  | { readonly type: 'tie'; readonly note: ParsedNote; readonly part: number }
  | { readonly type: 'bar'; readonly style: AbcBarStyle }
  | { readonly type: 'key'; readonly offsets: KeyOffsets; readonly fifths: number | undefined }
  | { readonly type: 'meter'; readonly meter: AbcMeter }
  | { readonly type: 'tempo'; readonly mark: AbcTempoMark };

/** A `(p:q:r` group being consumed: the next `remaining` notes/rests are scaled by q/p. */
interface ActiveTuplet {
  readonly id: number;
  readonly actual: number;
  readonly normal: number;
  readonly size: number;
  remaining: number;
}

interface VoiceState {
  readonly id: string;
  name: string | undefined;
  readonly notes: number[];
  /** Parallel to `notes`. */
  readonly spellings: NoteSpelling[];
  /** Parallel to `notes`: the finger decoration written for each note, if any. */
  readonly fingers: (number | undefined)[];
  /** Notes, rests, bar lines and key/meter/tempo changes in playing order (header events are added at the end, in `finish`). */
  readonly events: ParsedEvent[];
  /** The latest written part of a note or rest -- for a tied note only its last part: broken rhythm (`A>B` lengthens A and shortens B) dots that part, not the whole tie. */
  lastPiece: Piece | undefined;
  /** The latest note event, which a tie lengthens. */
  lastNoteEvent: ParsedNote | undefined;
  /** A meter set by an `M:` field in the body for this voice (`meterSet` says whether one was); decides the length of a multi-bar rest. */
  meter: AbcMeter | undefined;
  meterSet: boolean;
  /** `undefined` => use the tune's header key. */
  key: LetterOffsets | undefined;
  /** `${letter}${octave}` -> semitone offset set by an accidental earlier in this bar. */
  readonly barAccidentals: Map<string, number>;
  last: LastNote | undefined;
  tiePending: boolean;
  /** True from a `&` voice overlay to the next bar line: notes are tokenized but not emitted. */
  muted: boolean;
}

interface NoteToken {
  readonly letter: Letter;
  readonly octave: number;
  /** Explicit accidental on this note: +-1/2, 0 for a natural; `undefined` if none was written. */
  readonly accidental: number | undefined;
  readonly microtonal: boolean;
  /** Index just past the note (after any octave marks), before its length. */
  readonly end: number;
}

const DECORATION_CHARS = new Set(['.', '~']);
/** `h`-`w` / `H`-`W` are the (user-redefinable) single-letter decorations: trill, fermata, etc. None affects pitch. */
const DECORATION_LETTER = /^[h-wH-W]$/;
const REST_CHARS = new Set(['z', 'Z', 'x', 'X', 'y']);
const MAX_REPORTED_UNKNOWN_CHARS = 6;
/** A tuplet group longer than this is a typo; keeps the group bookkeeping bounded. */
const MAX_TUPLET_SIZE = 64;
/** `Z1000` is a typo, not a thousand bars of rest. */
const MAX_MULTI_REST_BARS = 64;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isNoteLetter(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Ga-g]$/.test(ch);
}

function skipLength(s: string, from: number): number {
  let j = from;
  while (j < s.length && (isDigit(s[j]) || s[j] === '/')) j += 1;
  return j;
}

/** Reads `[accidental]letter[octave marks]` at `i`, or `undefined` if `s[i]` doesn't start a note. */
function readNote(s: string, i: number): NoteToken | undefined {
  let j = i;
  let accidental: number | undefined;
  let microtonal = false;

  const sign = s[j];
  if (sign === '^' || sign === '_') {
    let count = 0;
    while (s[j] === sign && count < 2) {
      count += 1;
      j += 1;
    }
    accidental = sign === '^' ? count : -count;
    if (!isNoteLetter(s[j]) && (s[j] === '/' || isDigit(s[j]))) {
      // `^/C`, `_3/2B`: a quarter-tone-style accidental.
      microtonal = true;
      j = skipLength(s, j);
    }
  } else if (sign === '=') {
    accidental = 0;
    j += 1;
  }

  const letterChar = s[j];
  if (!isNoteLetter(letterChar)) return undefined;
  const upper = letterChar!.toUpperCase() as Letter;
  let octave = letterChar === upper ? 4 : 5;
  j += 1;
  while (s[j] === "'" || s[j] === ',') {
    octave += s[j] === "'" ? 1 : -1;
    j += 1;
  }
  return { letter: upper, octave, accidental, microtonal, end: j };
}

function stripComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '%') {
      i += 1;
    } else if (line[i] === '%') {
      return line.slice(0, i);
    }
  }
  return line;
}

const INFO_FIELD = /^([A-Za-z]):\s*(.*)$/;

function parseVoiceField(value: string): { id: string; name: string | undefined } | undefined {
  const id = value.trim().split(/\s+/)[0] ?? '';
  if (id.length === 0) return undefined;
  const nameMatch = /\b(?:name|nm)="([^"]*)"/.exec(value);
  return { id, name: nameMatch ? nameMatch[1] : undefined };
}

class TuneParser {
  private readonly voices = new Map<string, VoiceState>();
  private headerKey: LetterOffsets = emptyOffsets();
  private currentVoiceId = '';
  private readonly warnings: string[] = [];
  private readonly unknownChars = new Set<string>();
  private chordsReduced = 0;
  private microtonalSeen = false;
  private overlaySeen = false;
  private tieMismatchSeen = false;
  private unterminatedSeen = false;
  private macroSeen = false;
  private invalidLengthSeen = false;

  // Header results (decided when the `K:` line ends the header).
  private headerFifths: number | undefined = 0;
  private headerMeter: AbcMeter | undefined;
  private headerTempo: AbcTempoMark | undefined;
  private headerTempoText: string | undefined;
  private headerUnit = 1 / 8;
  /** `L:` as last written (header or body); `undefined` until one is, when ABC's default from the meter applies. */
  private explicitUnit: number | undefined;

  // Rhythm state that runs across the music.
  private tuplet: ActiveTuplet | undefined;
  private nextTupletId = 0;
  /** A finger decoration (`!2!`) waiting for the next note. */
  private pendingFinger: number | undefined;
  private pendingBroken: { readonly direction: '>' | '<'; readonly count: number } | undefined;
  /** True from a space/tab/line start/bar line until the next note or rest: the next element is *not* beamed to the previous one. */
  private spaceBefore = true;

  referenceNumber: string | undefined;
  title = '';
  composer: string | undefined;
  keyText = '';

  constructor(private readonly index: number) {}

  private voice(id: string): VoiceState {
    let state = this.voices.get(id);
    if (!state) {
      state = {
        id,
        name: undefined,
        notes: [],
        spellings: [],
        fingers: [],
        events: [],
        lastPiece: undefined,
        lastNoteEvent: undefined,
        meter: undefined,
        meterSet: false,
        key: undefined,
        barAccidentals: new Map(),
        last: undefined,
        tiePending: false,
        muted: false,
      };
      this.voices.set(id, state);
    }
    return state;
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  // --- Header and field lines ----------------------------------------

  /** A header field line (everything before and including `K:`). Returns true once the key line ends the header. */
  headerField(letter: string, value: string): boolean {
    switch (letter) {
      case 'X':
        this.referenceNumber = value.trim() || undefined;
        return false;
      case 'T':
        if (this.title === '') this.title = value.trim();
        return false;
      case 'C':
        if (this.composer === undefined && value.trim() !== '') this.composer = value.trim();
        return false;
      case 'V': {
        const v = parseVoiceField(value);
        if (v) {
          const state = this.voice(v.id);
          state.name ??= v.name;
          if (this.voices.size === 1) this.currentVoiceId = v.id;
        }
        return false;
      }
      case 'm':
        this.noteMacro();
        return false;
      case 'M': {
        const parsed = parseMeterField(value);
        this.headerMeter = parsed.meter;
        if (parsed.warning) this.warn(parsed.warning);
        return false;
      }
      case 'L':
        this.readUnitLength(value);
        return false;
      case 'Q':
        // Parsed once the header is complete: a bare `Q:120` depends on the meter, which may come after it.
        this.headerTempoText = value;
        return false;
      case 'K': {
        this.keyText = value.trim();
        const parsed = parseKeyField(this.keyText);
        this.headerKey = parsed.offsets;
        this.headerFifths = parsed.fifths;
        for (const w of parsed.warnings) this.warn(w);
        this.finishHeader();
        return true;
      }
      default:
        return false;
    }
  }

  private readUnitLength(value: string): void {
    const unit = parseFraction(value);
    if (unit === undefined) {
      this.warn(`Unrecognized unit note length "${value.trim()}" (L:); using the default.`);
    } else {
      this.explicitUnit = unit;
    }
  }

  /** The unit note length in force right now: the last `L:`, else ABC's default for the header meter. */
  private unit(): number {
    return this.explicitUnit ?? defaultUnitLength(this.headerMeter);
  }

  /** Called once, when the header ends (at `K:`, or when the body starts without one): resolves what depends on several header fields. */
  private finishHeader(): void {
    this.headerUnit = this.unit();
    if (this.headerTempoText !== undefined) {
      const parsed = parseTempoField(this.headerTempoText, this.headerMeter);
      this.headerTempo = parsed.mark;
      if (parsed.warning) this.warn(parsed.warning);
    }
  }

  private noteMacro(): void {
    if (!this.macroSeen) {
      this.macroSeen = true;
      this.warn('Macros (m: lines) are not expanded; notes written with a macro may be wrong.');
    }
  }

  /** Called when the header ended without a `K:` line. */
  noKeyLine(): void {
    this.warn('This tune has no K: (key) line; assuming no key signature.');
    this.finishHeader();
  }

  /** A field line inside the body (including via an inline `[X:...]`). */
  bodyField(letter: string, value: string): void {
    switch (letter) {
      case 'K': {
        const parsed = parseKeyField(value.trim());
        for (const w of parsed.warnings) this.warn(w);
        const voice = this.voice(this.currentVoiceId);
        voice.key = parsed.offsets;
        voice.events.push({ type: 'key', offsets: parsed.offsets, fifths: parsed.fifths });
        return;
      }
      case 'M': {
        const parsed = parseMeterField(value);
        if (parsed.warning) this.warn(parsed.warning);
        const voice = this.voice(this.currentVoiceId);
        voice.meter = parsed.meter;
        voice.meterSet = true;
        if (parsed.meter) voice.events.push({ type: 'meter', meter: parsed.meter });
        return;
      }
      case 'L':
        this.readUnitLength(value);
        return;
      case 'Q': {
        const voice = this.voice(this.currentVoiceId);
        const parsed = parseTempoField(value, voice.meterSet ? voice.meter : this.headerMeter);
        if (parsed.warning) this.warn(parsed.warning);
        if (parsed.mark) voice.events.push({ type: 'tempo', mark: parsed.mark });
        return;
      }
      case 'V': {
        const v = parseVoiceField(value);
        if (v) {
          const state = this.voice(v.id);
          state.name ??= v.name;
          this.currentVoiceId = v.id;
        }
        return;
      }
      case 'm':
        this.noteMacro();
        return;
      default:
        return;
    }
  }

  // --- Music ------------------------------------------------------------

  private currentVoice(): VoiceState {
    return this.voice(this.currentVoiceId);
  }

  private resolveOffset(
    voice: VoiceState,
    token: NoteToken,
    tiedFrom: LastNote | undefined,
  ): number {
    const positionKey = `${token.letter}${token.octave}`;
    if (token.accidental !== undefined) {
      voice.barAccidentals.set(positionKey, token.accidental);
      return token.accidental;
    }
    if (tiedFrom && tiedFrom.letter === token.letter && tiedFrom.octave === token.octave) {
      // An accidental carries across a tie, even into the next bar.
      return tiedFrom.offset;
    }
    const inBar = voice.barAccidentals.get(positionKey);
    if (inBar !== undefined) return inBar;
    return (voice.key ?? this.headerKey)[token.letter];
  }

  private toLastNote(
    voice: VoiceState,
    token: NoteToken,
    tiedFrom: LastNote | undefined,
  ): LastNote {
    const offset = this.resolveOffset(voice, token, tiedFrom);
    return {
      letter: token.letter,
      octave: token.octave,
      offset,
      midi: 12 * (token.octave + 1) + LETTER_SEMITONES[token.letter] + offset,
    };
  }

  private noteInvalidLength(): void {
    if (this.invalidLengthSeen) return;
    this.invalidLengthSeen = true;
    this.warn(
      'A note length is zero or out of range (for example "A0"); it was treated as a normal-length note.',
    );
  }

  /**
   * Works out the sounding and written length of the next note or rest from
   * its length multiplier: the unit note length, then the active tuplet
   * (`(3` scales by 2/3 and remembers the group), then a pending broken rhythm
   * (`>` / `<`) from the element before it.
   */
  private timing(multiplier: number): Piece {
    let notated = this.unit() * multiplier;
    let duration = notated;
    let tuplet: AbcTuplet | undefined;

    const active = this.tuplet;
    if (active) {
      duration = notated * (active.normal / active.actual);
      tuplet = {
        id: active.id,
        actual: active.actual,
        normal: active.normal,
        size: active.size,
        index: active.size - active.remaining,
      };
      active.remaining -= 1;
      if (active.remaining <= 0) this.tuplet = undefined;
    }

    const broken = this.pendingBroken;
    if (broken) {
      this.pendingBroken = undefined;
      const factor = broken.direction === '>' ? 2 ** -broken.count : 2 - 2 ** -broken.count;
      notated *= factor;
      duration *= factor;
    }
    return { duration, notated, tuplet };
  }

  /** `(p`, `(p:q`, `(p:q:r`: p notes in the time of q, for the next r notes/rests. q defaults per the ABC standard (2->3, 3->2, 4->3, 5/7/9 -> 2 in simple time or 3 in compound, 6->2, 8->3). */
  private startTuplet(
    voice: VoiceState,
    actual: number,
    normal: number | undefined,
    size: number | undefined,
  ): void {
    if (actual < 2) return;
    const meter = voice.meterSet ? voice.meter : this.headerMeter;
    const compound = meter !== undefined && meter.beatLengthWhole * meter.denominator > 2;
    const odd = compound ? 3 : 2;
    const defaultNormal: Readonly<Record<number, number>> = {
      2: 3,
      3: 2,
      4: 3,
      5: odd,
      6: 2,
      7: odd,
      8: 3,
      9: odd,
    };
    const resolvedNormal =
      normal !== undefined && normal >= 1
        ? normal
        : (defaultNormal[actual] ?? 2 ** Math.floor(Math.log2(actual)));
    const resolvedSize = Math.min(MAX_TUPLET_SIZE, size !== undefined && size >= 1 ? size : actual);
    this.tuplet = {
      id: this.nextTupletId,
      actual,
      normal: resolvedNormal,
      size: resolvedSize,
      remaining: resolvedSize,
    };
    this.nextTupletId += 1;
  }

  /** `>`, `>>`, `>>>` (or `<`...): the element before gets longer (or shorter) and the one after the opposite. */
  private brokenRhythm(voice: VoiceState, direction: '>' | '<', count: number): void {
    const piece = voice.lastPiece;
    if (!piece) return;
    const factor = direction === '>' ? 2 - 2 ** -count : 2 ** -count;
    piece.duration *= factor;
    piece.notated *= factor;
    this.pendingBroken = { direction, count };
  }

  /** Emits one played note (or adds a part to the note it is tied to). */
  private emit(voice: VoiceState, note: LastNote, piece: Piece, beamed: boolean): void {
    const tied = voice.tiePending;
    voice.tiePending = false;
    const previous = voice.lastNoteEvent;
    if (tied && voice.last && voice.last.midi === note.midi && previous) {
      // One note to play, as long as all its parts together; each part still passes its own time.
      previous.pieces.push(piece);
      voice.events.push({ type: 'tie', note: previous, part: previous.pieces.length - 1 });
      voice.last = note;
      voice.lastPiece = piece;
      return;
    }
    if (tied && !this.tieMismatchSeen) {
      this.tieMismatchSeen = true;
      this.warn('A tie joins two different pitches; both notes are included.');
    }
    const event: ParsedNote = {
      type: 'note',
      noteIndex: voice.notes.length,
      beamed,
      pieces: [piece],
    };
    voice.events.push(event);
    voice.notes.push(note.midi);
    voice.spellings.push({ letter: note.letter, accidental: note.offset, octave: note.octave });
    voice.fingers.push(note.finger);
    voice.last = note;
    voice.lastNoteEvent = event;
    voice.lastPiece = piece;
  }

  private note(s: string, token: NoteToken): number {
    const voice = this.currentVoice();
    if (token.microtonal && !this.microtonalSeen) {
      this.microtonalSeen = true;
      this.warn(
        'Microtonal accidentals (like ^/ or _3/2) are not supported; the plain sharp/flat is used.',
      );
    }
    const length = readLength(s, token.end);
    if (length.invalid) this.noteInvalidLength();
    if (!voice.muted) {
      const beamed = !this.spaceBefore;
      this.spaceBefore = false;
      const tiedFrom = voice.tiePending ? voice.last : undefined;
      const finger = this.pendingFinger;
      this.pendingFinger = undefined;
      this.emit(
        voice,
        { ...this.toLastNote(voice, token, tiedFrom), finger },
        this.timing(length.multiplier),
        beamed,
      );
    }
    this.pendingFinger = undefined;
    return length.end;
  }

  /** Parses a `[...]` chord starting at `i` (`s[i] === '['`). Returns the index to continue from. */
  private chord(s: string, i: number): number {
    const close = s.indexOf(']', i + 1);
    if (close === -1) {
      if (!this.unterminatedSeen) {
        this.unterminatedSeen = true;
        this.warn(
          'A chord ([...) is missing its closing bracket; the rest of that line was skipped.',
        );
      }
      return s.length;
    }
    const voice = this.currentVoice();
    const tiedFrom = voice.tiePending ? voice.last : undefined;
    const members: LastNote[] = [];
    // A chord lasts as long as its *first* note (times the length after the bracket), as abcjs does.
    let firstMultiplier: number | undefined;
    // A finger decoration before a chord member belongs to that member; only the top note is played.
    let memberFinger: number | undefined;
    const outerFinger = this.pendingFinger;
    this.pendingFinger = undefined;
    let j = i + 1;
    while (j < close) {
      const ch = s[j]!;
      if (ch === '"') {
        const end = s.indexOf('"', j + 1);
        j = end === -1 || end > close ? close : end + 1;
        continue;
      }
      if (ch === '!') {
        const end = s.indexOf('!', j + 1);
        if (end !== -1 && end <= close) memberFinger = fingerOfDecoration(s.slice(j + 1, end));
        j = end === -1 || end > close ? j + 1 : end + 1;
        continue;
      }
      const token = readNote(s, j);
      if (token) {
        if (token.microtonal && !this.microtonalSeen) {
          this.microtonalSeen = true;
          this.warn(
            'Microtonal accidentals (like ^/ or _3/2) are not supported; the plain sharp/flat is used.',
          );
        }
        if (!voice.muted) {
          members.push({ ...this.toLastNote(voice, token, tiedFrom), finger: memberFinger });
        }
        memberFinger = undefined;
        const inner = readLength(s, token.end);
        if (inner.invalid) this.noteInvalidLength();
        firstMultiplier ??= inner.multiplier;
        j = inner.end;
        continue;
      }
      // Spaces, ties on individual chord notes, decorations, stray characters: nothing to play.
      j += 1;
    }
    const outer = readLength(s, close + 1);
    if (outer.invalid) this.noteInvalidLength();
    if (members.length > 0 && !voice.muted) {
      const top = members.reduce((a, b) => (b.midi > a.midi ? b : a));
      if (members.some((m) => m.midi !== top.midi)) this.chordsReduced += 1;
      const beamed = !this.spaceBefore;
      this.spaceBefore = false;
      this.emit(
        voice,
        { ...top, finger: top.finger ?? outerFinger },
        this.timing((firstMultiplier ?? 1) * outer.multiplier),
        beamed,
      );
    }
    return outer.end;
  }

  /** A rest of `multiplier` unit lengths; `visible` is false for `x`. */
  private rest(voice: VoiceState, multiplier: number, visible: boolean): void {
    this.pendingFinger = undefined; // a decoration before a rest belongs to the rest
    if (voice.muted) return;
    const beamed = !this.spaceBefore;
    this.spaceBefore = false;
    const piece = this.timing(multiplier);
    voice.events.push({ type: 'rest', visible, beamed, pieces: [piece] });
    voice.lastPiece = piece;
  }

  /** `Zn` / `Xn`: `n` whole bars of rest in the current meter, kept as one rest per bar with a bar line between so the bars stay countable. */
  private multiBarRest(voice: VoiceState, bars: number, visible: boolean): void {
    if (voice.muted) return;
    const meter = (voice.meterSet ? voice.meter : this.headerMeter) ?? DEFAULT_METER;
    for (let bar = 0; bar < bars; bar += 1) {
      if (bar > 0) voice.events.push({ type: 'bar', style: 'single' });
      const piece: Piece = {
        duration: meter.barLengthWhole,
        notated: meter.barLengthWhole,
        tuplet: undefined,
      };
      voice.events.push({ type: 'rest', visible, beamed: false, pieces: [piece] });
      voice.lastPiece = piece;
    }
    this.spaceBefore = true;
  }

  private barLine(s: string, i: number): number {
    const voice = this.currentVoice();
    voice.barAccidentals.clear();
    voice.muted = false;
    let j = i;
    if (s[j] === '[') j += 1;
    while (s[j] === '|' || s[j] === ':') j += 1;
    if (s[j] === ']' && s[j - 1] === '|') j += 1;
    voice.events.push({ type: 'bar', style: barStyleOf(s.slice(i, j)) });
    this.spaceBefore = true;
    if (isDigit(s[j])) {
      // First/second ending number right after the bar (`|1`, `:|2`, `|1,2`).
      while (isDigit(s[j]) || s[j] === ',' || s[j] === '-') j += 1;
    }
    return j;
  }

  /** Tokenizes one music line (already comment-stripped and trimmed). */
  musicLine(raw: string): void {
    const s = raw.endsWith('\\') ? raw.slice(0, -1) : raw;
    let i = 0;
    this.spaceBefore = true;
    while (i < s.length) {
      const ch = s[i]!;

      if (ch === ' ' || ch === '\t') {
        this.spaceBefore = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        const end = s.indexOf('"', i + 1);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      if (ch === '!') {
        // `!trill!`-style decoration; a lone `!` is an old-style line break. `!1!`...`!4!` / `!0!` are fingerings.
        const end = s.indexOf('!', i + 1);
        if (end !== -1)
          this.pendingFinger = fingerOfDecoration(s.slice(i + 1, end)) ?? this.pendingFinger;
        i = end === -1 ? i + 1 : end + 1;
        continue;
      }
      if (ch === '+') {
        const end = s.indexOf('+', i + 1);
        if (end !== -1)
          this.pendingFinger = fingerOfDecoration(s.slice(i + 1, end)) ?? this.pendingFinger;
        i = end === -1 ? i + 1 : end + 1;
        continue;
      }
      if (ch === '{') {
        // Grace notes take no time and are not practice notes.
        const end = s.indexOf('}', i + 1);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      if (ch === '(') {
        i += 1;
        if (isDigit(s[i])) {
          // Tuplet marker `(3`, `(3:2`, `(3:2:3` -- not a slur.
          const numbers: Array<number | undefined> = [undefined, undefined, undefined];
          for (let field = 0; field < 3; field += 1) {
            let digits = '';
            while (isDigit(s[i])) {
              digits += s[i];
              i += 1;
            }
            numbers[field] = digits === '' ? undefined : Number.parseInt(digits, 10);
            if (s[i] !== ':') break;
            i += 1;
          }
          if (numbers[0] !== undefined) {
            this.startTuplet(this.currentVoice(), numbers[0], numbers[1], numbers[2]);
          }
        }
        continue;
      }
      if (ch === ')' || ch === '*' || ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '>' || ch === '<') {
        let count = 0;
        while (s[i] === ch && count < 3) {
          count += 1;
          i += 1;
        }
        this.brokenRhythm(this.currentVoice(), ch, count);
        continue;
      }
      if (ch === '[') {
        const next = s[i + 1];
        if (next !== undefined && /^[A-Za-z]$/.test(next) && s[i + 2] === ':') {
          const end = s.indexOf(']', i + 1);
          if (end === -1) {
            i = s.length;
            continue;
          }
          this.bodyField(next, s.slice(i + 3, end));
          i = end + 1;
          continue;
        }
        if (next === '|') {
          i = this.barLine(s, i);
          continue;
        }
        if (isDigit(next)) {
          // `[1` / `[2` first/second ending.
          i += 1;
          while (isDigit(s[i]) || s[i] === ',' || s[i] === '-') i += 1;
          continue;
        }
        i = this.chord(s, i);
        continue;
      }
      if (ch === '|' || ch === ':') {
        i = this.barLine(s, i);
        continue;
      }
      if (ch === '-') {
        const voice = this.currentVoice();
        if (voice.last && !voice.muted) voice.tiePending = true;
        i += 1;
        continue;
      }
      if (ch === '&') {
        if (!this.overlaySeen) {
          this.overlaySeen = true;
          this.warn('Voice overlays (&) are not supported; the overlaid notes are skipped.');
        }
        this.currentVoice().muted = true;
        i += 1;
        continue;
      }
      if (REST_CHARS.has(ch)) {
        const voice = this.currentVoice();
        voice.tiePending = false;
        if (ch === 'y') {
          // A spacer: takes room on the page, no time.
          i = skipLength(s, i + 1);
          continue;
        }
        if (ch === 'Z' || ch === 'X') {
          let digits = '';
          let j = i + 1;
          while (isDigit(s[j])) {
            digits += s[j];
            j += 1;
          }
          const bars =
            digits === '' ? 1 : Math.min(MAX_MULTI_REST_BARS, Number.parseInt(digits, 10));
          if (bars >= 1) this.multiBarRest(voice, bars, ch === 'Z');
          i = j;
          continue;
        }
        const length = readLength(s, i + 1);
        if (length.invalid) this.noteInvalidLength();
        this.rest(voice, length.multiplier, ch === 'z');
        i = length.end;
        continue;
      }
      if (DECORATION_CHARS.has(ch) || DECORATION_LETTER.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '/' || isDigit(ch)) {
        // A stray length modifier with no note in front of it.
        i = skipLength(s, i);
        continue;
      }

      const token = readNote(s, i);
      if (token) {
        i = this.note(s, token);
        continue;
      }

      // Anything else is something this parser doesn't understand.
      if (this.unknownChars.size < MAX_REPORTED_UNKNOWN_CHARS) this.unknownChars.add(ch);
      i += 1;
    }
  }

  finish(): AbcTune {
    if (this.chordsReduced > 0) {
      this.warn(
        `${this.chordsReduced} chord${this.chordsReduced === 1 ? '' : 's'}/double-stop${
          this.chordsReduced === 1 ? '' : 's'
        } found; only the top note of each is practiced.`,
      );
    }
    if (this.unknownChars.size > 0) {
      const shown = [...this.unknownChars].map((c) => `"${c}"`).join(', ');
      this.warn(`Skipped characters this parser doesn't understand: ${shown}.`);
    }

    // What every voice starts with: the header key, meter and tempo, at position 0.
    const headerEvents: ParsedEvent[] = [
      { type: 'key', offsets: this.headerKey, fifths: this.headerFifths },
    ];
    if (this.headerMeter) headerEvents.push({ type: 'meter', meter: this.headerMeter });
    if (this.headerTempo) headerEvents.push({ type: 'tempo', mark: this.headerTempo });
    const meterAtStart = this.headerMeter ?? DEFAULT_METER;
    const scoreOf = (voice: VoiceState | undefined): AbcVoiceScore =>
      buildVoiceScore([...headerEvents, ...(voice?.events ?? [])], meterAtStart);

    let voices: AbcVoice[] = [...this.voices.values()]
      .filter((v) => v.notes.length > 0)
      .map((v) => ({
        id: v.id,
        name: v.name,
        notes: v.notes,
        spellings: v.spellings,
        fingers: v.fingers,
        score: scoreOf(v),
      }));
    if (voices.length === 0) {
      const only = this.voices.get(this.currentVoiceId) ?? [...this.voices.values()][0];
      voices = [
        {
          id: only?.id ?? '',
          name: only?.name,
          notes: [],
          spellings: [],
          fingers: [],
          score: scoreOf(only),
        },
      ];
    }
    if (voices.length > 1) {
      const labels = voices
        .map((v) => (v.name ? `${v.id} (${v.name})` : v.id || '(default)'))
        .join(', ');
      this.warn(
        `This tune has ${voices.length} voices (${labels}); the first one (${voices[0]!.id || 'default'}) is used for practice.`,
      );
    }

    // Bars that do not add up to the meter usually mean a wrong note length, L: or M: -- which would
    // misplace every note in the timed play-along -- so say so (for the voice that is practiced).
    const practiced = voices[0]!;
    const meterChanges = practiced.score.elements.some((e, n) => e.type === 'meter' && n > 1);
    if (this.headerMeter && !meterChanges) {
      const irregular = irregularBars(practiced.score, this.headerMeter);
      if (irregular.length > 0) {
        const first = irregular[0]!;
        const number = practiced.score.pickupWhole > 0 ? first : first + 1;
        const length =
          (practiced.score.barStartsWhole[first + 1] ?? practiced.score.totalWhole) -
          practiced.score.barStartsWhole[first]!;
        const beats = Math.round((length / this.headerMeter.beatLengthWhole) * 100) / 100;
        const what =
          irregular.length === 1
            ? `Bar ${number} has ${beats} beats instead of ${this.headerMeter.beatsPerBar} (${this.headerMeter.display})`
            : `${irregular.length} bars are not ${this.headerMeter.display} long (the first, bar ${number}, has ${beats} beats instead of ${this.headerMeter.beatsPerBar})`;
        this.warn(
          `${what}. Check the note lengths and the M:/L: lines; otherwise the metronome beat will not line up with the bar lines.`,
        );
      }
    }

    return {
      index: this.index,
      referenceNumber: this.referenceNumber,
      title: this.title,
      composer: this.composer,
      key: this.keyText,
      meter: this.headerMeter,
      tempo: this.headerTempo,
      unitNoteLength: this.headerUnit,
      voices,
      warnings: this.warnings,
    };
  }
}

// --- File-level parse ----------------------------------------------------

interface RawTune {
  readonly lines: string[];
}

/**
 * Parses an ABC file (one or more tunes) into pitch sequences. Never
 * throws; see the module doc comment for what is and isn't interpreted.
 */
export function parseAbc(text: string): AbcParseResult {
  if (text.length > MAX_ABC_TEXT_LENGTH) {
    return {
      tunes: [],
      warnings: [
        `This file is too large to be an ABC tune (over ${MAX_ABC_TEXT_LENGTH.toLocaleString('en-US')} characters).`,
      ],
    };
  }

  const fileWarnings: string[] = [];
  const rawTunes: RawTune[] = [];
  let current: RawTune | undefined;
  let strayLines = 0;
  // After a blank line ends a tune, anything that isn't the start of a new tune is stray.
  let afterTuneEnd = false;

  const source = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const rawLine of source) {
    const trimmedRaw = rawLine.trim();
    if (trimmedRaw.startsWith('%')) continue; // comment or %%directive
    const line = stripComment(rawLine).trim();

    if (line === '') {
      if (current) {
        rawTunes.push(current);
        current = undefined;
        afterTuneEnd = true;
      }
      continue;
    }

    const isTuneStart = /^X:/.test(line);
    if (isTuneStart) {
      if (current) rawTunes.push(current);
      current = { lines: [line] };
      afterTuneEnd = false;
      continue;
    }
    if (current) {
      current.lines.push(line);
      continue;
    }
    if (INFO_FIELD.test(line)) {
      // A tune without an X: line (or a file header): start collecting at the first field.
      current = { lines: [line] };
      afterTuneEnd = false;
      continue;
    }
    if (afterTuneEnd) strayLines += 1;
  }
  if (current) rawTunes.push(current);

  const tunes: AbcTune[] = [];
  for (const raw of rawTunes) {
    const tune = parseTune(raw.lines, tunes.length);
    if (tune) tunes.push(tune);
  }

  if (strayLines > 0) {
    fileWarnings.push(
      `Ignored ${strayLines} line${strayLines === 1 ? '' : 's'} of text after a blank line outside any tune (a blank line ends an ABC tune).`,
    );
  }
  if (tunes.length === 0) {
    fileWarnings.unshift(
      'No ABC tune was found in this file (expected X:/K: header lines followed by notes).',
    );
  }
  return { tunes, warnings: fileWarnings };
}

/** Returns `undefined` for a chunk that is only a file header (fields but no key line and no music). */
function parseTune(lines: readonly string[], index: number): AbcTune | undefined {
  const parser = new TuneParser(index);

  let bodyStart = lines.length;
  let sawKey = false;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!;
    const field = INFO_FIELD.exec(line);
    if (!field) {
      bodyStart = n;
      break;
    }
    if (parser.headerField(field[1]!, field[2]!)) {
      sawKey = true;
      bodyStart = n + 1;
      break;
    }
  }

  const bodyLines = lines.slice(bodyStart);
  const hasMusicLine = bodyLines.some((l) => !INFO_FIELD.test(l));
  if (!sawKey && !hasMusicLine) return undefined;
  if (!sawKey) parser.noKeyLine();

  let continued = false;
  for (const line of bodyLines) {
    const field = continued ? null : INFO_FIELD.exec(line);
    if (field) {
      parser.bodyField(field[1]!, field[2]!);
      continued = false;
      continue;
    }
    parser.musicLine(line);
    continued = line.endsWith('\\');
  }

  return parser.finish();
}
