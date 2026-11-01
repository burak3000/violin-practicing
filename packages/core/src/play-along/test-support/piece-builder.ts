/**
 * Test-only helper: builds a valid `AbcPiece` by hand from a list of
 * `{ midi, startWhole, durationWhole }`, so the play-along tests do not depend
 * on the ABC parser (which produces `AbcPiece`s from text, and is owned by
 * someone else). Not exported from the package.
 */

import {
  NO_KEY_OFFSETS,
  WHOLE_EPSILON,
  createMeter,
  defaultTempoMark,
} from '../../abc/abc-score.js';
import type {
  AbcMeter,
  AbcNoteElement,
  AbcPiece,
  AbcRestElement,
  AbcScoreElement,
  AbcTempoMark,
} from '../../abc/abc-score.js';
import { midiNumberToNoteName, midiToFrequencyHz } from '../../note/note.js';
import { spellMidi } from '../../notation/note-spelling.js';
import type { NoteSpelling } from '../../notation/note-spelling.js';
import type { SequenceNote } from '../../sequence/sequence-generator.js';

export interface TestNote {
  readonly midi: number;
  readonly startWhole: number;
  readonly durationWhole: number;
  /** How the note is written (default: the sharps-only spelling of `midi`). */
  readonly spelling?: NoteSpelling;
}

export interface BuildPieceOptions {
  /** Default 4/4. */
  readonly meter?: AbcMeter;
  /** Default: a quarter-note beat at 60 bpm (1000 ms per quarter, easy to reason about). */
  readonly tempo?: AbcTempoMark;
  /** Length of the leading partial bar in whole notes. Default 0. */
  readonly pickupWhole?: number;
  /** Mid-piece tempo changes (each in the same beat unit as `tempo` unless it says otherwise). */
  readonly tempoMarks?: readonly { at: number; bpm: number; beatLengthWhole?: number }[];
  /** Mid-piece meter changes; each `at` should be a bar start. */
  readonly meterChanges?: readonly { at: number; meter: AbcMeter }[];
  /** End of the piece; default: the end of the last note. */
  readonly totalWhole?: number;
}

export const QUARTER_AT_60: AbcTempoMark = { beatLengthWhole: 0.25, bpm: 60, text: undefined };

/** Notes of equal length, back to back from position 0 (or from `startWhole`). */
export function consecutiveNotes(
  midis: readonly number[],
  durationWhole: number,
  startWhole = 0,
): TestNote[] {
  return midis.map((midi, i) => ({
    midi,
    startWhole: startWhole + i * durationWhole,
    durationWhole,
  }));
}

/** Bar starts for a pickup, meter changes and a total length -- what the parser would report. */
function computeBarStarts(
  meter: AbcMeter,
  pickupWhole: number,
  meterChanges: readonly { at: number; meter: AbcMeter }[],
  totalWhole: number,
): number[] {
  const starts = [0];
  let position = 0;
  if (pickupWhole > WHOLE_EPSILON) {
    starts.push(pickupWhole);
    position = pickupWhole;
  }
  const meterAt = (p: number): AbcMeter => {
    let current = meter;
    for (const change of meterChanges) {
      if (change.at <= p + WHOLE_EPSILON) current = change.meter;
    }
    return current;
  };
  for (;;) {
    const next = position + meterAt(position).barLengthWhole;
    if (next >= totalWhole - WHOLE_EPSILON) break;
    starts.push(next);
    position = next;
  }
  return starts;
}

export function buildTestPiece(
  notes: readonly TestNote[],
  options: BuildPieceOptions = {},
): AbcPiece {
  const meter = options.meter ?? createMeter(4, 4);
  const tempo = options.tempo ?? QUARTER_AT_60;
  const pickupWhole = options.pickupWhole ?? 0;
  const meterChanges = options.meterChanges ?? [];
  const lastEnd = notes.reduce((max, n) => Math.max(max, n.startWhole + n.durationWhole), 0);
  const totalWhole = options.totalWhole ?? lastEnd;
  const barStartsWhole = computeBarStarts(meter, pickupWhole, meterChanges, totalWhole);

  const barOf = (position: number): number => {
    let bar = 0;
    for (let i = 0; i < barStartsWhole.length; i++) {
      if (barStartsWhole[i]! <= position + WHOLE_EPSILON) bar = i;
    }
    return bar;
  };

  const sequence: SequenceNote[] = notes.map((n) => ({
    note: midiNumberToNoteName(n.midi),
    frequencyHz: midiToFrequencyHz(n.midi),
    spelling: n.spelling ?? spellMidi(n.midi),
  }));

  const noteElements: AbcNoteElement[] = notes.map((n, noteIndex) => ({
    type: 'note',
    noteIndex,
    start: n.startWhole,
    duration: n.durationWhole,
    notated: n.durationWhole,
    beamedToPrevious: false,
    tuplet: undefined,
    bar: barOf(n.startWhole),
  }));

  const elements: AbcScoreElement[] = [
    { type: 'key', at: 0, offsets: NO_KEY_OFFSETS, fifths: 0 },
    { type: 'meter', at: 0, meter },
    { type: 'tempo', at: 0, mark: tempo },
  ];
  for (const change of meterChanges) {
    elements.push({ type: 'meter', at: change.at, meter: change.meter });
  }
  for (const mark of options.tempoMarks ?? []) {
    elements.push({
      type: 'tempo',
      at: mark.at,
      mark: {
        beatLengthWhole: mark.beatLengthWhole ?? tempo.beatLengthWhole,
        bpm: mark.bpm,
        text: undefined,
      },
    });
  }
  // Rests fill any gap between notes, so the element list is a faithful timeline.
  let cursor = 0;
  for (const el of noteElements) {
    if (el.start - cursor > WHOLE_EPSILON) {
      const rest: AbcRestElement = {
        type: 'rest',
        start: cursor,
        duration: el.start - cursor,
        notated: el.start - cursor,
        visible: true,
        beamedToPrevious: false,
        tuplet: undefined,
        bar: barOf(cursor),
      };
      elements.push(rest);
    }
    elements.push(el);
    cursor = Math.max(cursor, el.start + el.duration);
  }
  elements.sort((a, b) => positionOf(a) - positionOf(b));

  return {
    notes: sequence,
    noteElements,
    elements,
    meter,
    meterAssumed: options.meter === undefined,
    tempo,
    tempoSource: options.tempo === undefined ? 'default' : 'file',
    totalWhole,
    pickupWhole,
    barCount: barStartsWhole.length,
    barStartsWhole,
    keyAtStart: NO_KEY_OFFSETS,
  };
}

function positionOf(element: AbcScoreElement): number {
  switch (element.type) {
    case 'note':
    case 'rest':
      return element.start;
    case 'bar':
    case 'key':
    case 'meter':
    case 'tempo':
      return element.at;
  }
}

/** The default tempo the parser would assume for a meter, re-exported so tests can build "no tempo in the file" pieces. */
export { defaultTempoMark };
