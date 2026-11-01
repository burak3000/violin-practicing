/**
 * Turns a parsed ABC tune into the `SequenceNote[]` that
 * `PracticeSessionController` / `PlayingPracticeMachine` already consume --
 * so sheet-music practice runs through exactly the same target-note scoring,
 * give-up policy and Drilling hand-off as the procedural scale modes, with
 * nothing in the session layer needing to know the notes came from a file.
 *
 * ## Range handling: refuse, don't silently drop
 *
 * Playing Practice's procedural generator can quietly filter notes outside
 * the detector's range because every note is interchangeable. A melody isn't:
 * dropping the notes the app can't hear would leave a sequence that no
 * longer matches the sheet. So a tune with any note below the violin's
 * lowest string (G3) or above the detector's validated ceiling (default
 * 1600Hz, the same default `generatePlayingPracticeSequence` uses) is
 * *rejected as a whole*, with a count and -- when some whole-octave shift
 * would make every note playable -- a suggested transposition, rather than
 * practiced in part. Many ABC files are written an octave off from where a
 * violinist expects them; `transposeSemitones` is how the user fixes that.
 *
 * Pure TypeScript, no platform imports.
 */

import {
  DEFAULT_A4_HZ,
  midiNumberToNoteName,
  midiToFrequencyHz,
  type NoteName,
} from '../note/note.js';
import { openStringNote } from '../note/violin-strings.js';
import { formatSpellingLabel, transposeSpelling } from '../notation/note-spelling.js';
import {
  DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ,
  DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ,
  staffSpellingOf,
  type SequenceNote,
} from '../sequence/sequence-generator.js';
import type { AbcTune, AbcVoice } from './abc-parser.js';
import {
  DEFAULT_METER,
  NO_KEY_OFFSETS,
  WHOLE_EPSILON,
  defaultTempoMark,
  type AbcNoteElement,
  type AbcPiece,
  type AbcScoreElement,
} from './abc-score.js';

export interface AbcPracticeOptions {
  /** Which voice of the tune to practice. Default: the first voice. */
  readonly voiceId?: string;
  /** Shift every note by this many semitones before range-checking (e.g. `12` = up an octave). Default 0. */
  readonly transposeSemitones?: number;
  /** Reference pitch. Default 440. */
  readonly a4Hz?: number;
  /** Detector floor in Hz; the effective floor is never below the violin's open G. Default 150. */
  readonly minFrequencyHz?: number;
  /** Detector ceiling in Hz. Default 3000. */
  readonly maxFrequencyHz?: number;
}

export type AbcPracticeSequence =
  | {
      readonly status: 'ok';
      readonly notes: readonly SequenceNote[];
      readonly voiceId: string;
      readonly transposeSemitones: number;
      readonly lowest: NoteName;
      readonly highest: NoteName;
      /** The same range as the sheet spells it ("B♭3", "F♯5"); `lowest`/`highest` are the sharps-only names of the sounding pitches. */
      readonly lowestLabel: string;
      readonly highestLabel: string;
      /** The notes with their rhythm, bars, key/meter/tempo and notation: what the play-along and the staff display use. */
      readonly piece: AbcPiece;
    }
  | { readonly status: 'empty'; readonly message: string }
  | {
      readonly status: 'out-of-range';
      readonly message: string;
      readonly outOfRangeCount: number;
      readonly noteCount: number;
      readonly lowest: NoteName;
      readonly highest: NoteName;
      /** A whole-octave shift (in semitones, never 0) that brings every note into range, if one exists. */
      readonly suggestedTransposeSemitones: number | undefined;
    };

/** Lowest note a violin can sound: the open G string. */
const LOWEST_PLAYABLE_MIDI = openStringNote('G').midi;

/** Largest whole-octave shift considered when suggesting a transposition. */
const MAX_SUGGESTED_OCTAVES = 3;

function pickVoice(tune: AbcTune, voiceId: string | undefined): AbcVoice | undefined {
  if (voiceId === undefined) {
    return tune.voices.find((v) => v.notes.length > 0) ?? tune.voices[0];
  }
  return tune.voices.find((v) => v.id === voiceId);
}

function describeShift(semitones: number): string {
  const octaves = semitones / 12;
  const count = Math.abs(octaves);
  return `${octaves > 0 ? 'up' : 'down'} ${count === 1 ? 'an octave' : `${count} octaves`}`;
}

export function buildAbcPracticeSequence(
  tune: AbcTune,
  options: AbcPracticeOptions = {},
): AbcPracticeSequence {
  const voice = pickVoice(tune, options.voiceId);
  if (voice === undefined) {
    return { status: 'empty', message: `This tune has no voice "${options.voiceId}".` };
  }
  if (voice.notes.length === 0) {
    return { status: 'empty', message: 'This tune has no playable notes.' };
  }

  const a4Hz = options.a4Hz ?? DEFAULT_A4_HZ;
  const transposeSemitones = options.transposeSemitones ?? 0;
  const minFrequencyHz = options.minFrequencyHz ?? DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ;
  const maxFrequencyHz = options.maxFrequencyHz ?? DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ;

  const isPlayable = (midi: number): boolean => {
    if (midi < LOWEST_PLAYABLE_MIDI) return false;
    const hz = midiToFrequencyHz(midi, a4Hz);
    return hz >= minFrequencyHz && hz <= maxFrequencyHz;
  };

  const shifted = voice.notes.map((midi) => midi + transposeSemitones);
  const lowestMidi = Math.min(...shifted);
  const highestMidi = Math.max(...shifted);
  const lowest = midiNumberToNoteName(lowestMidi);
  const highest = midiNumberToNoteName(highestMidi);

  const outOfRangeCount = shifted.filter((midi) => !isPlayable(midi)).length;
  if (outOfRangeCount > 0) {
    let suggestedTransposeSemitones: number | undefined;
    for (
      let octaves = 1;
      octaves <= MAX_SUGGESTED_OCTAVES && suggestedTransposeSemitones === undefined;
      octaves += 1
    ) {
      for (const sign of [1, -1]) {
        const delta = sign * octaves * 12;
        if (shifted.every((midi) => isPlayable(midi + delta))) {
          suggestedTransposeSemitones = transposeSemitones + delta;
          break;
        }
      }
    }

    const range = `${spelledLabel(voice, shifted, lowestMidi, transposeSemitones)} to ${spelledLabel(voice, shifted, highestMidi, transposeSemitones)}`;
    const hint =
      suggestedTransposeSemitones === undefined
        ? 'No whole-octave shift fits this tune on a violin.'
        : `Try transposing ${describeShift(suggestedTransposeSemitones - transposeSemitones)}.`;
    return {
      status: 'out-of-range',
      message: `${outOfRangeCount} of ${shifted.length} notes are outside what a violin can play and the app can detect (this tune spans ${range}). ${hint}`,
      outOfRangeCount,
      noteCount: shifted.length,
      lowest,
      highest,
      suggestedTransposeSemitones,
    };
  }

  const notes: SequenceNote[] = shifted.map((midi, i) => ({
    note: midiNumberToNoteName(midi),
    frequencyHz: midiToFrequencyHz(midi, a4Hz),
    // Keep the written spelling (B-flat stays B-flat; octave shifts don't change it).
    spelling: transposeSpelling(voice.spellings[i]!, transposeSemitones),
    // The file's finger numbers were written for the sheet's own pitches: after any transposition
    // the notes sit on other strings, so they no longer apply (a suggestion is computed instead).
    ...(transposeSemitones === 0 && voice.fingers[i] !== undefined
      ? { finger: voice.fingers[i]! }
      : {}),
  }));
  return {
    status: 'ok',
    notes,
    voiceId: voice.id,
    transposeSemitones,
    lowest,
    highest,
    lowestLabel: spelledLabel(voice, shifted, lowestMidi, transposeSemitones),
    highestLabel: spelledLabel(voice, shifted, highestMidi, transposeSemitones),
    piece: buildPiece(voice, notes, transposeSemitones),
  };
}

/** The sheet's own spelling of the first note sounding at `midi` (after transposition) -- "B♭3", not "A#3". */
function spelledLabel(
  voice: AbcVoice,
  shifted: readonly number[],
  midi: number,
  transposeSemitones: number,
): string {
  const index = shifted.indexOf(midi);
  const spelling = voice.spellings[index];
  return spelling === undefined
    ? midiNumberToNoteName(midi).label
    : formatSpellingLabel(transposeSpelling(spelling, transposeSemitones));
}

/**
 * Pairs the practice notes with the score the parser read for their voice. A
 * transposition by whole octaves keeps the key signature (the same key, an
 * octave away); any other shift re-spells every note with sharps, which no
 * longer matches the written key, so the key signature is dropped and each
 * altered note carries its own sign instead.
 */
function buildPiece(
  voice: AbcVoice,
  notes: readonly SequenceNote[],
  transposeSemitones: number,
): AbcPiece {
  const keepKey = transposeSemitones % 12 === 0;
  const elements: readonly AbcScoreElement[] = keepKey
    ? voice.score.elements
    : voice.score.elements.map((element) =>
        element.type === 'key' ? { ...element, offsets: NO_KEY_OFFSETS, fifths: 0 } : element,
      );

  const noteElements: AbcNoteElement[] = [];
  for (const element of elements) {
    if (element.type === 'note') noteElements[element.noteIndex] = element;
  }

  // What is in force at the very start: the first key/meter/tempo element at position 0.
  const atStart = (element: AbcScoreElement) => 'at' in element && element.at <= WHOLE_EPSILON;
  const keyElement = elements.find((e) => e.type === 'key' && atStart(e));
  const meterElement = elements.find((e) => e.type === 'meter' && atStart(e));
  const tempoElement = elements.find((e) => e.type === 'tempo' && atStart(e));
  const meter = meterElement?.type === 'meter' ? meterElement.meter : DEFAULT_METER;

  return {
    notes,
    noteElements,
    elements,
    meter,
    meterAssumed: meterElement === undefined,
    tempo: tempoElement?.type === 'tempo' ? tempoElement.mark : defaultTempoMark(meter),
    tempoSource: tempoElement === undefined ? 'default' : 'file',
    totalWhole: voice.score.totalWhole,
    pickupWhole: voice.score.pickupWhole,
    barCount: voice.score.barCount,
    barStartsWhole: voice.score.barStartsWhole,
    keyAtStart: keyElement?.type === 'key' ? keyElement.offsets : NO_KEY_OFFSETS,
  };
}

/** How a tune is named in a tune picker: "<X: number or position>: <title>". */
export function abcTuneLabel(tune: AbcTune): string {
  const number = tune.referenceNumber ?? String(tune.index + 1);
  return `${number}: ${tune.title || 'Untitled'}`;
}

/** How many note names the summary previews before eliding the rest. */
const SUMMARY_PREVIEW_NOTES = 12;

/**
 * The few-line preview shown after importing a tune (same text on desktop and
 * mobile): title and key, then -- if the tune can be practiced -- how many
 * notes and their range, then the first few note names. When it can't be
 * practiced only the heading is returned; the reason is `result.message`.
 */
export function abcPracticeSummary(tune: AbcTune, result: AbcPracticeSequence): string {
  const heading = [
    tune.title || 'Untitled',
    tune.key ? `key ${tune.key}` : undefined,
    tune.meter?.display,
  ]
    .filter((part) => part !== undefined)
    .join(' \u00b7 ');
  if (result.status !== 'ok') return heading;
  const labels = result.notes.map((n) => formatSpellingLabel(staffSpellingOf(n)));
  const shown =
    labels.length > SUMMARY_PREVIEW_NOTES
      ? `${labels.slice(0, SUMMARY_PREVIEW_NOTES).join(' ')} \u2026`
      : labels.join(' ');
  return `${heading}\n${labels.length} notes, ${result.lowestLabel} to ${result.highestLabel}\n${shown}`;
}
