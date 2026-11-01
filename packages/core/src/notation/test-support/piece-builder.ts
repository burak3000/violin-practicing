/**
 * Test-only helper: builds a valid `AbcPiece` by hand from a short text, so the
 * notation tests do not depend on the ABC parser (which produces `AbcPiece`s
 * from ABC text and is owned elsewhere), and so a test can state exactly which
 * rhythms, bars and beams it wants. Not exported from the package.
 *
 * ## The mini-language
 *
 * Space-separated tokens, in playing order:
 *
 * - `F#4:1/8` -- a note: pitch (letter, optional `#` `##` `b` `bb`, octave) and
 *   its written length as a fraction of a whole note; `:3/16` is a dotted eighth,
 *   a trailing `.` / `..` dots the value (`:1/4.` = 3/8). Any fraction is allowed,
 *   including ones no single note head can show (`:5/8`) and longer than the bar.
 * - A trailing `~` (`G4:1/2~ | G4:1/4`) ties the note to the next note of the same
 *   pitch, which is *merged* into it as the parser does (one note element, longer
 *   duration) -- the way to build a note that runs over a bar line.
 * - A leading `^` (`^G4:1/8`) marks the item as beamed to the previous one, as
 *   the ABC parser does when no space separates them in the source.
 * - `z:1/4` a rest; `x:1/4` an invisible rest (takes time, drawn as nothing).
 * - `|` single, `||` double, `|]` final, `|:` repeat-start, `:|` repeat-end,
 *   `:|:` repeat-both bar lines. Like the parser, a bar line only starts a new
 *   bar if something came since the previous one.
 * - `(3` -- the next 3 notes/rests form a triplet (actual 3 in the time of 2);
 *   `(5/4` is an explicit "5 in the time of 4". The written lengths after it are
 *   the *notated* values; the sounding duration is scaled.
 * - `K:2` / `K:-3` -- a key change to that many sharps (flats if negative) from
 *   here; `M:3/4`, `M:C`, `M:C|` -- a meter change.
 *
 * Options set the key and meter at the start. Every note's frequency is
 * equal-tempered at A4 = 440.
 */

import {
  NO_KEY_OFFSETS,
  WHOLE_EPSILON,
  createMeter,
  defaultTempoMark,
  type AbcBarStyle,
  type AbcMeter,
  type AbcNoteElement,
  type AbcPiece,
  type AbcRestElement,
  type AbcScoreElement,
  type AbcTuplet,
  type KeyOffsets,
} from '../../abc/abc-score.js';
import { midiNumberToNoteName, midiToFrequencyHz } from '../../note/note.js';
import type { SequenceNote } from '../../sequence/sequence-generator.js';
import { spellingToMidi, type NoteLetter, type NoteSpelling } from '../note-spelling.js';

const SHARP_ORDER: readonly NoteLetter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: readonly NoteLetter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Key signature offsets for a position on the circle of fifths (+n sharps / -n flats; beyond 7 the letters go double). */
export function keyOffsetsForFifths(fifths: number): KeyOffsets {
  const out = { ...NO_KEY_OFFSETS } as Record<NoteLetter, number>;
  const order = fifths >= 0 ? SHARP_ORDER : FLAT_ORDER;
  const sign = fifths >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(fifths); i += 1) {
    out[order[i % 7]!] += sign;
  }
  return out;
}

/** Parses "F#4", "Bb3", "C5", "Ebb4", "G##4". */
export function parsePitch(text: string): NoteSpelling {
  const match = /^([A-G])(##|#|bb|b)?(-?\d)$/.exec(text);
  if (match === null) throw new Error(`piece-builder: bad pitch "${text}"`);
  const sign = match[2] ?? '';
  const accidental = sign === '' ? 0 : sign[0] === '#' ? sign.length : -sign.length;
  return { letter: match[1] as NoteLetter, accidental, octave: Number(match[3]) };
}

function parseMeter(text: string): AbcMeter {
  if (text === 'C') return createMeter(4, 4, 'common');
  if (text === 'C|') return createMeter(2, 2, 'cut');
  const [n, d] = text.split('/').map(Number);
  return createMeter(n!, d!);
}

function parseLength(text: string): number {
  const match = /^(\d+)\/(\d+)(\.{0,2})$/.exec(text);
  if (match === null) throw new Error(`piece-builder: bad length "${text}"`);
  const dots = match[3]!.length;
  return (Number(match[1]) / Number(match[2])) * (2 - 2 ** -dots);
}

const BAR_TOKENS: Readonly<Record<string, AbcBarStyle>> = {
  '|': 'single',
  '||': 'double',
  '|]': 'final',
  '|:': 'repeat-start',
  ':|': 'repeat-end',
  ':|:': 'repeat-both',
};

export interface BuildPieceOptions {
  /** Key at the start: a position on the circle of fifths (default 0) or explicit offsets. */
  readonly key?: number | KeyOffsets;
  /** Meter at the start: "4/4" (default), "3/4", "6/8", "C", "C|". */
  readonly meter?: string;
  /** Total length to report (default: the end of the last note). */
  readonly totalWhole?: number;
  /** Report the meter as assumed (the file gave none), as the parser does without an `M:` line. Default false. */
  readonly meterAssumed?: boolean;
}

export function buildPiece(spec: string, options: BuildPieceOptions = {}): AbcPiece {
  const keyOption = options.key ?? 0;
  const startOffsets = typeof keyOption === 'number' ? keyOffsetsForFifths(keyOption) : keyOption;
  const startFifths = typeof keyOption === 'number' ? keyOption : undefined;
  const meter = parseMeter(options.meter ?? '4/4');

  const elements: AbcScoreElement[] = [
    { type: 'key', at: 0, offsets: startOffsets, fifths: startFifths },
    { type: 'meter', at: 0, meter },
  ];
  const notes: SequenceNote[] = [];
  const noteElements: AbcNoteElement[] = [];
  const barStarts: number[] = [0];

  let position = 0;
  let bar = 0;
  let barHasContent = false;
  let tupletId = 0;
  /** The last note, if its token ended with `~`: the next note of the same pitch joins it. */
  let tieOpen: { note: { duration: number; notated: number }; spelling: NoteSpelling } | undefined;
  let pendingTuplet:
    { id: number; actual: number; normal: number; size: number; taken: number } | undefined;

  for (const raw of spec.split(/\s+/).filter((t) => t.length > 0)) {
    if (raw in BAR_TOKENS) {
      const style = BAR_TOKENS[raw]!;
      if (barHasContent) {
        elements.push({ type: 'bar', at: position, style, after: bar });
        bar += 1;
        barStarts.push(position);
        barHasContent = false;
      } else {
        elements.push({ type: 'bar', at: position, style, after: bar - 1 });
      }
      continue;
    }
    if (raw.startsWith('K:')) {
      const fifths = Number(raw.slice(2));
      elements.push({ type: 'key', at: position, offsets: keyOffsetsForFifths(fifths), fifths });
      continue;
    }
    if (raw.startsWith('M:')) {
      elements.push({ type: 'meter', at: position, meter: parseMeter(raw.slice(2)) });
      continue;
    }
    if (raw.startsWith('(')) {
      const [a, n] = raw.slice(1).split('/').map(Number);
      const actual = a!;
      const defaultNormal = actual === 2 || actual === 4 ? 3 : 2;
      pendingTuplet = { id: tupletId, actual, normal: n ?? defaultNormal, size: actual, taken: 0 };
      tupletId += 1;
      continue;
    }

    let token = raw;
    const beamed = token.startsWith('^');
    if (beamed) token = token.slice(1);
    const tiedForward = token.endsWith('~');
    if (tiedForward) token = token.slice(0, -1);
    const [head, length] = token.split(':');
    if (head === undefined || length === undefined) {
      throw new Error(`piece-builder: bad token "${raw}"`);
    }
    const notated = parseLength(length);

    let tuplet: AbcTuplet | undefined;
    let duration = notated;
    if (pendingTuplet !== undefined) {
      duration = (notated * pendingTuplet.normal) / pendingTuplet.actual;
      tuplet = {
        id: pendingTuplet.id,
        actual: pendingTuplet.actual,
        normal: pendingTuplet.normal,
        size: pendingTuplet.size,
        index: pendingTuplet.taken,
      };
      pendingTuplet.taken += 1;
      if (pendingTuplet.taken >= pendingTuplet.size) pendingTuplet = undefined;
    }

    if (head === 'z' || head === 'x') {
      const rest: AbcRestElement = {
        type: 'rest',
        start: position,
        duration,
        notated,
        visible: head === 'z',
        beamedToPrevious: beamed,
        tuplet,
        bar,
      };
      elements.push(rest);
    } else if (
      tieOpen !== undefined &&
      JSON.stringify(parsePitch(head)) === JSON.stringify(tieOpen.spelling)
    ) {
      // A tie: the continuation is part of the note already placed.
      (tieOpen.note as { duration: number; notated: number }).duration += duration;
      (tieOpen.note as { duration: number; notated: number }).notated += notated;
      tieOpen = tiedForward ? tieOpen : undefined;
    } else {
      const spelling = parsePitch(head);
      const midi = spellingToMidi(spelling);
      const noteIndex = notes.length;
      notes.push({
        note: midiNumberToNoteName(midi),
        frequencyHz: midiToFrequencyHz(midi, 440),
        spelling,
      });
      const note: AbcNoteElement = {
        type: 'note',
        noteIndex,
        start: position,
        duration,
        notated,
        beamedToPrevious: beamed,
        tuplet,
        bar,
      };
      noteElements.push(note);
      elements.push(note);
      tieOpen = tiedForward ? { note, spelling } : undefined;
    }
    position += duration;
    barHasContent = true;
  }

  const barCount = barHasContent ? bar + 1 : bar;
  const starts = barStarts.slice(0, Math.max(barCount, 0));
  const firstBarLength = (starts[1] ?? position) - 0;
  const pickupWhole =
    barCount > 1 && firstBarLength < meter.barLengthWhole - WHOLE_EPSILON ? firstBarLength : 0;

  return {
    notes,
    noteElements,
    elements,
    meter,
    meterAssumed: options.meterAssumed ?? false,
    tempo: defaultTempoMark(meter),
    tempoSource: 'default',
    totalWhole: options.totalWhole ?? position,
    pickupWhole,
    barCount,
    barStartsWhole: starts,
    keyAtStart: startOffsets,
  };
}
