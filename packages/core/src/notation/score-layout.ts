/**
 * Geometry for drawing a *rhythmic* score: the notation of an ABC piece with
 * its note values, rests, bar lines, key and time signatures, beams, ties,
 * tuplets and the accidentals a printed sheet would carry. Pure layout, no
 * rendering -- like `staff-layout.ts` it returns what to draw and where, and
 * each platform draws the flat list of primitives with its own tiny renderer
 * (`score-svg.ts` turns it into SVG markup for desktop; mobile maps the same
 * primitives onto `react-native-svg`).
 *
 * `staff-layout.ts` stays as it is: Playing Practice still shows one
 * rhythm-less, quarter-note-style staff. This module is the second, richer
 * layout, for pieces that have rhythm.
 *
 * ## Units and orientation
 *
 * Same as `staff-layout.ts`: **staff spaces**, x right, y *down*, top line at
 * y = 0, bottom line at y = 4, so glyph outlines (`staff-glyphs.ts`, Bravura)
 * drop in with no scaling. Note positions come from `staffPosition` (half-spaces
 * above the bottom line, E4 = 0).
 *
 * ## What it does, in order
 *
 * 1. **Window.** The caller names the first bar and a width in staff spaces; as
 *    many consecutive bars as fit (at least one) are laid out, the way a
 *    printed system holds a few bars. Every window starts with the clef and
 *    the key signature in force there; the time signature only where it is new
 *    (the start of the piece, or a change) unless the caller asks for it.
 * 2. **Note values.** A note is drawn with the value it is *written* with
 *    (`notated`, so a triplet eighth is an eighth). A duration no single head can
 *    show (5/8) or that runs over a bar line is cut into the fewest tied
 *    values, longest first. Dots, up to two.
 * 3. **Spacing.** Proportional-ish, not linear: a note's space grows with the
 *    logarithm of its duration (a 16th ~2.2 staff spaces, a quarter ~5, a whole
 *    ~8), because a linear scale would make a whole note forty times as wide as
 *    a 32nd. Room is kept for accidentals and dots. Windows are then stretched a
 *    little to fill the line, as printed systems are, except the last one of a
 *    piece.
 * 4. **Stems, beams, flags.** Stem direction follows the farthest head from the
 *    middle line, per *group* (a beamed or tuplet group shares one direction).
 *    Stems attach at the font's own anchors (`SMUFL_ANCHORS`). Beams follow the
 *    written beaming (`beamedToPrevious`), slope gently, and break at rests.
 * 5. **Accidentals** come from `computeDisplayAccidentals` -- only where the
 *    key signature and the bar do not already say it.
 *
 * ## Playhead mapping and highlighting
 *
 * `ScoreLayout.xForWhole(whole)` maps a position in the piece (whole notes) to
 * an x in the layout, so a play-along cursor can sweep across the notation.
 * Every primitive that belongs to one practice note carries its `noteIndex`, so
 * a UI can colour a note as hit/missed/target without re-deriving anything.
 *
 * Pure TypeScript; no platform imports.
 */

import {
  WHOLE_EPSILON,
  sameWhole,
  type AbcBarElement,
  type AbcBarStyle,
  type AbcKeyElement,
  type AbcMeter,
  type AbcMeterElement,
  type AbcNoteElement,
  type AbcPiece,
  type AbcRestElement,
  type KeyOffsets,
} from '../abc/abc-score.js';
import { staffSpellingOf } from '../sequence/sequence-generator.js';
import {
  computeDisplayAccidentals,
  displayedKeyOffsets,
  keySignatureGlyphs,
  type KeySignatureAccidental,
} from './score-accidentals.js';
import {
  SMUFL_ANCHORS,
  SMUFL_ENGRAVING,
  STAFF_GLYPHS,
  type StaffGlyphName,
} from './staff-glyphs.js';
import { staffPosition } from './staff-layout.js';
import type { FingerMark } from './fingering.js';

// =================================================================================
// Public types
// =================================================================================

/** What a primitive is part of: lets a renderer (or a test) treat staff furniture and notes differently. */
export type ScorePart =
  | 'staff-line'
  | 'clef'
  | 'key-signature'
  | 'time-signature'
  | 'bar-line'
  | 'ledger-line'
  | 'head'
  | 'stem'
  | 'flag'
  | 'beam'
  | 'accidental'
  | 'dot'
  | 'tie'
  | 'rest'
  | 'tuplet'
  /** A violin finger number over a note, as written in the ABC file. */
  | 'finger';

/**
 * One thing to draw, in staff-space coordinates. The list is flat and in draw
 * order so both renderers stay tiny. `noteIndex` (the practice-note index) is
 * set on every part that belongs to a particular note -- head, stem, flag,
 * accidental, dots, ledger lines, tie -- so the UI can colour it; beams,
 * rests, bar lines and tuplet marks carry none.
 */
export type ScorePrimitive =
  | {
      readonly kind: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width: number;
      readonly part: ScorePart;
      readonly noteIndex?: number;
    }
  | {
      /** `translate(x, y)` then fill `STAFF_GLYPHS[glyph].path` (already in staff spaces). */
      readonly kind: 'glyph';
      readonly glyph: StaffGlyphName;
      readonly x: number;
      readonly y: number;
      readonly part: ScorePart;
      readonly noteIndex?: number;
    }
  | {
      /** A filled polygon (beams). */
      readonly kind: 'polygon';
      readonly points: readonly (readonly [number, number])[];
      readonly part: ScorePart;
      readonly noteIndex?: number;
    }
  | {
      /** A filled crescent (ties) or a stroked open path (tuplet brackets): absolute coordinates, M/L/C/Z only. */
      readonly kind: 'path';
      readonly d: string;
      readonly width: number;
      readonly filled: boolean;
      readonly part: ScorePart;
      readonly noteIndex?: number;
    }
  | {
      /** A filled dot (repeat-bar dots). */
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly part: ScorePart;
      readonly noteIndex?: number;
    };

/** One practice note that is on screen. A note tied across several heads is one entry (its first head). */
export interface ScoreNoteLayout {
  readonly noteIndex: number;
  /** Left edge of the (first) notehead. */
  readonly x: number;
  /** Horizontal center of the (first) notehead. */
  readonly xCenter: number;
  /** Vertical center of the notehead (staff spaces, top line = 0). */
  readonly y: number;
  readonly stemUp: boolean;
  /** How many tied heads are drawn for this note in the window (more than one when its value needs tying). */
  readonly pieces: number;
}

export interface ScoreBarLine {
  /** x of the line (the thin line of a final bar line; the thick line of a repeat sign). */
  readonly x: number;
  /** Index of the bar this line *ends*; -1 or the previous window's bar for a repeat sign opening the window. */
  readonly bar: number;
}

export interface ScoreLayout {
  /** [minX, minY, width, height] -- use directly as an SVG `viewBox`. */
  readonly viewBox: readonly [number, number, number, number];
  /** Everything to draw, in draw order. */
  readonly primitives: readonly ScorePrimitive[];
  readonly firstBar: number;
  /** Last bar drawn (inclusive): as many consecutive bars from `firstBar` as fit, at least one. */
  readonly lastBar: number;
  /** True if even the first bar needed more room than `widthSpaces` (the layout is then wider than asked). */
  readonly overflow: boolean;
  /** Width the window needs at the natural (un-stretched) spacing, in staff spaces. */
  readonly widthSpaces: number;
  /** One per practice note shown, in note order. */
  readonly notes: readonly ScoreNoteLayout[];
  readonly barLines: readonly ScoreBarLine[];
  /**
   * Playhead mapping: the x of a position in the piece (whole notes from the
   * start). Piecewise-linear through the centers of the notes and rests, so the
   * cursor glides rather than jumps; before the window it is the first
   * note's x, after it the right end of the last bar. Never decreases.
   */
  xForWhole(whole: number): number;
}

export interface ScoreLayoutOptions {
  /** First bar of the window (clamped into the piece). */
  readonly firstBar: number;
  /** Width available, in staff spaces. */
  readonly widthSpaces: number;
  /**
   * Draw the time signature after the key signature. Default: only in the
   * window that starts the piece (unless the file gave no meter and 4/4 was
   * merely assumed) or where the meter changes at the window's first bar -- a
   * printed system repeats the key signature but not the meter.
   */
  readonly showTimeSignature?: boolean;
  /** Never draw more than this many bars (default: as many as fit). */
  readonly maxBars?: number;
  /**
   * Stretch the bars' spacing (up to about a third) so the window fills the
   * width, as a printed line is justified. Default true; the last window of a
   * piece is never stretched.
   */
  readonly justify?: boolean;
  /**
   * Finger numbers to print over the notes, indexed by practice-note index (`fingerMarksOf`).
   * Each is drawn above its note (and its stem or beam), centred on the head; it takes no
   * horizontal room, so the spacing is the same with or without. Absent => none.
   */
  readonly fingers?: readonly (FingerMark | undefined)[];
}

export interface ScoreSizeOptions {
  readonly firstBar: number;
  readonly availableWidthPx: number;
  /** Never make the score taller than this (px). */
  readonly maxHeightPx?: number;
  /** Limits on the *preferred* size of one staff space (defaults 10 and 34); the size is aimed at ~55 spaces across. */
  readonly minUnitPx?: number;
  readonly maxUnitPx?: number;
  readonly showTimeSignature?: boolean;
  /** See `ScoreLayoutOptions.fingers`. */
  readonly fingers?: readonly (FingerMark | undefined)[];
}

export interface ScoreSize {
  readonly layout: ScoreLayout;
  /** px per staff space. */
  readonly unitPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

// =================================================================================
// Note values
// =================================================================================

/** A single representable note value: a base value (1 = whole ... 1/32) with 0-2 augmentation dots. */
export interface NoteValue {
  /** 1, 1/2, 1/4, 1/8, 1/16 or 1/32. */
  readonly base: number;
  readonly dots: 0 | 1 | 2;
  /** Total length in whole notes including the dots. */
  readonly whole: number;
  /** Flags (or beams) it carries: 0 for quarter and longer, 1 for an eighth ... 3 for a 32nd. */
  readonly flags: 0 | 1 | 2 | 3;
}

const BASES: readonly { base: number; flags: 0 | 1 | 2 | 3 }[] = [
  { base: 1, flags: 0 },
  { base: 1 / 2, flags: 0 },
  { base: 1 / 4, flags: 0 },
  { base: 1 / 8, flags: 1 },
  { base: 1 / 16, flags: 2 },
  { base: 1 / 32, flags: 3 },
];

/** Every value a note can be drawn with (6 bases x 0..2 dots), longest first. */
const NOTE_VALUES: readonly NoteValue[] = BASES.flatMap(({ base, flags }) =>
  ([2, 1, 0] as const).map((dots) => ({ base, dots, whole: base * (2 - 2 ** -dots), flags })),
).sort((a, b) => b.whole - a.whole);

const SHORTEST_VALUE = 1 / 32;
/** A piece of a split note is never more than this many heads: a guard against absurd input, not a limit anyone meets. */
const MAX_PIECES_PER_SEGMENT = 64;

/** The single value equal to `whole`, if there is one (a quarter, a dotted eighth, a double-dotted half ...). */
export function exactNoteValue(whole: number): NoteValue | undefined {
  return NOTE_VALUES.find((v) => Math.abs(v.whole - whole) <= WHOLE_EPSILON);
}

/**
 * Cuts a length into the fewest note values, longest first (5/8 -> half +
 * eighth). Shorter than a 32nd is drawn as a 32nd (nothing finer is
 * engraved here); zero or negative lengths still give one 32nd so a note is
 * never invisible. Notes are tied by the caller.
 */
export function splitIntoNoteValues(whole: number): NoteValue[] {
  const exact = exactNoteValue(whole);
  if (exact !== undefined) return [exact];
  const out: NoteValue[] = [];
  let remaining = Number.isFinite(whole) ? whole : 0;
  while (remaining >= SHORTEST_VALUE / 2 && out.length < MAX_PIECES_PER_SEGMENT) {
    const next = NOTE_VALUES.find((v) => v.whole <= remaining + WHOLE_EPSILON);
    if (next === undefined) break;
    out.push(next);
    remaining -= next.whole;
  }
  if (out.length === 0) out.push(NOTE_VALUES[NOTE_VALUES.length - 1]!);
  return out;
}

// =================================================================================
// Constants
// =================================================================================

const E = SMUFL_ENGRAVING;
const STEM_W = E.stemThickness;
const BEAM_T = E.beamThickness;
const BEAM_STEP = E.beamThickness + E.beamSpacing;
const STAFF_LINE_W = E.staffLineThickness;

const HEAD_BLACK = STAFF_GLYPHS.noteheadBlack.width;

/** Horizontal layout (staff spaces). */
const CLEF_X = 0.3;
/** Clef to key signature, key signature to time signature (and clef to time signature when there is no key). */
const CLEF_TO_KEY = 0.9;
const KEY_TO_TIME = 1.1;
const KEY_GLYPH_GAP = 0.12;
/** Distance from the start of a bar (right after its opening bar line or the preamble) to the first notehead. */
const START_PAD = 1.0;
/** The same after the clef / key / time signature that opens a window, and after an inline signature change: a little more air. */
const PREAMBLE_PAD = 1.5;
const AFTER_SIGNATURE_PAD = 1.2;
/** Clear space between the preamble and a repeat sign that opens the window. */
const OPENING_GAP = 0.6;
/** The space a note "owns" ends this far before the bar line, so the next bar's first note follows it at the same spacing. */
const BAR_GAP = 1.0;
const CLEAR = 0.55;
const ACCIDENTAL_GAP = 0.25;
const DOT_GAP = 0.5;
const DOT_STEP = 0.45;
/** Extra distance a dot is moved right of its head when an up-stem flag would otherwise sit on it. */
const FLAG_DOT_CLEARANCE = 0.4;
const DOT_RADIUS = STAFF_GLYPHS.augmentationDot.width / 2;
/** Space around an inline key/time-signature change. */
const SIG_PAD = 0.8;
const EMPTY_BAR_WIDTH = 4;
const END_MARGIN = 0.6;
const MAX_STRETCH = 1.3;

/** Spacing curve: a note's space = SPACE_16TH + SPACE_PER_DOUBLING * log2(duration / 16th), clamped. */
const SPACE_16TH = 2.2;
const SPACE_PER_DOUBLING = 1.4;
const MIN_SPACE = 1.9;
const MAX_SPACE = 9.5;

/** Vertical extent shown by default: the open G (G3, two ledger lines below) up to the detector's G6 ceiling (four above). */
const DEFAULT_MIN_Y = -5.3;
const DEFAULT_MAX_Y = 7.7;
const EXTENT_MARGIN = 0.25;

/** Stems. */
const STEM_LENGTH = 3.5;
const MIDDLE_LINE_Y = 2;
const MAX_BEAM_SLOPE = 0.25;
const BEAM_SLOPE_DAMPING = 0.5;
const STUB_LENGTH = 1.0;

/** Ledger lines extend this far beyond the head on each side. */
const LEDGER_EXTENSION = E.legerLineExtension;

const TIE_SIDE_GAP = 0.45;
const TIE_STUB = 1.6;

/** Aim for about this many staff spaces across when choosing the size of one space. */
const TARGET_SPACES_ACROSS = 55;
const FLOOR_UNIT_PX = 6;

// =================================================================================
// Spacing
// =================================================================================

/** Space a note or rest of this sounding duration is given, head to head. */
export function spaceForDuration(whole: number): number {
  if (!(whole > 0)) return MIN_SPACE;
  const space = SPACE_16TH + SPACE_PER_DOUBLING * Math.log2(whole * 16);
  return Math.min(MAX_SPACE, Math.max(MIN_SPACE, space));
}

// =================================================================================
// Piece index: everything that does not depend on the window
// =================================================================================

type Item = AbcNoteElement | AbcRestElement;

interface PieceDesc {
  readonly item: Item;
  readonly itemIndex: number;
  readonly indexInItem: number;
  pieceCount: number;
  readonly bar: number;
  /** Where this head sounds (whole notes). */
  readonly start: number;
  /** How long it sounds (whole notes) -- what spacing is proportional to. */
  readonly sound: number;
  readonly value: NoteValue;
}

interface ScoreIndex {
  readonly barCount: number;
  readonly barStarts: readonly number[];
  readonly endWhole: number;
  readonly items: readonly Item[];
  readonly piecesByBar: readonly PieceDesc[][];
  /** Staff position per item (notes only; rests get 4). */
  readonly positions: readonly number[];
  /** Stem direction per item, shared across its beam/tuplet group. */
  readonly stemUp: readonly boolean[];
  /** Item indexes of each beam group, in order. */
  readonly beamGroups: readonly (readonly number[])[];
  readonly beamGroupOfItem: readonly number[];
  readonly keyEvents: readonly AbcKeyElement[];
  readonly meterEvents: readonly AbcMeterElement[];
  readonly barElements: ReadonlyMap<number, readonly AbcBarElement[]>;
  readonly accidentals: ReadonlyMap<number, number>;
}

const indexCache = new WeakMap<AbcPiece, ScoreIndex>();

function indexOf(piece: AbcPiece): ScoreIndex {
  let index = indexCache.get(piece);
  if (index === undefined) {
    index = buildIndex(piece);
    indexCache.set(piece, index);
  }
  return index;
}

function isNote(item: Item): item is AbcNoteElement {
  return item.type === 'note';
}

/** Cuts one note or rest into the heads that draw it (see `splitIntoNoteValues`), at bar lines for non-tuplet items. */
function splitItem(
  item: Item,
  itemIndex: number,
  barStarts: readonly number[],
  barCount: number,
  clampBar: (bar: number) => number,
): PieceDesc[] {
  const pieces: PieceDesc[] = [];
  const startBar = clampBar(item.bar);
  const push = (bar: number, start: number, sound: number, value: NoteValue): void => {
    pieces.push({
      item,
      itemIndex,
      indexInItem: pieces.length,
      pieceCount: 0,
      bar,
      start,
      sound,
      value,
    });
  };

  if (item.tuplet !== undefined) {
    // A tuplet is drawn in the bar it starts in, with the value it is written as.
    const notated = item.notated > WHOLE_EPSILON ? item.notated : item.duration;
    const scale = notated > WHOLE_EPSILON ? item.duration / notated : 1;
    let start = item.start;
    for (const value of splitIntoNoteValues(notated)) {
      push(startBar, start, value.whole * scale, value);
      start += value.whole * scale;
    }
  } else {
    let remaining = Math.max(0, item.duration);
    let start = item.start;
    let bar = startBar;
    const segments: { bar: number; start: number; length: number }[] = [];
    if (remaining <= WHOLE_EPSILON) segments.push({ bar, start, length: 0 });
    while (remaining > WHOLE_EPSILON) {
      const hasNext = bar + 1 < barCount;
      const room = hasNext ? barStarts[bar + 1]! - start : Number.POSITIVE_INFINITY;
      if (hasNext && room <= WHOLE_EPSILON) {
        bar += 1;
        continue;
      }
      const length = Math.min(remaining, room);
      segments.push({ bar, start, length });
      start += length;
      remaining -= length;
      if (remaining > WHOLE_EPSILON) bar += 1;
    }
    for (const segment of segments) {
      let at = segment.start;
      for (const value of splitIntoNoteValues(segment.length)) {
        // Shorter than the shortest value we can draw: keep the real length for spacing.
        const sound =
          segment.length < SHORTEST_VALUE - WHOLE_EPSILON ? segment.length : value.whole;
        push(segment.bar, at, sound, value);
        at += value.whole;
      }
    }
  }
  for (const p of pieces) p.pieceCount = pieces.length;
  return pieces;
}

/** Merges the bar lines that end one bar into a single style (a repeat sign wins; `:|` plus `|:` is `:|:`). */
function mergeBarStyles(elements: readonly AbcBarElement[]): AbcBarStyle {
  const has = (...styles: AbcBarStyle[]) => elements.some((e) => styles.includes(e.style));
  const ends = has('repeat-end', 'repeat-both');
  const starts = has('repeat-start', 'repeat-both');
  if (ends && starts) return 'repeat-both';
  if (ends) return 'repeat-end';
  if (starts) return 'repeat-start';
  if (has('final')) return 'final';
  if (has('double')) return 'double';
  return 'single';
}

function buildIndex(piece: AbcPiece): ScoreIndex {
  const items = piece.elements.filter((e): e is Item => e.type === 'note' || e.type === 'rest');
  const barCount = Math.max(1, Math.trunc(piece.barCount) || 0);

  // Bar starts, made non-decreasing and at least one per bar so nothing downstream can index out of range.
  const barStarts: number[] = [];
  for (let b = 0; b < barCount; b += 1) {
    const raw = piece.barStartsWhole[b];
    const previous = b > 0 ? barStarts[b - 1]! : 0;
    barStarts.push(b === 0 ? 0 : Math.max(previous, Number.isFinite(raw) ? raw! : previous));
  }
  const clampBar = (bar: number): number =>
    Math.min(barCount - 1, Math.max(0, Number.isFinite(bar) ? Math.trunc(bar) : 0));

  const itemEnd = items.reduce((m, e) => Math.max(m, e.start + Math.max(0, e.duration)), 0);
  const endWhole = Math.max(piece.totalWhole, itemEnd, barStarts[barCount - 1]!);

  // Pieces per item, then per bar (items are in time order, so appending keeps each bar's pieces in order).
  const piecesByBar: PieceDesc[][] = Array.from({ length: barCount }, () => []);
  const piecesOfItem: PieceDesc[][] = [];
  items.forEach((item, i) => {
    const pieces = splitItem(item, i, barStarts, barCount, clampBar);
    piecesOfItem.push(pieces);
    for (const p of pieces) piecesByBar[p.bar]!.push(p);
  });

  const positions = items.map((item) =>
    isNote(item) && piece.notes[item.noteIndex] !== undefined
      ? staffPosition(staffSpellingOf(piece.notes[item.noteIndex]!))
      : 4,
  );

  // Beam groups: runs of notes written without a gap, each a single head of eighth value or shorter, in one bar, no rest between.
  const eligible = items.map(
    (item, i) =>
      isNote(item) && piecesOfItem[i]!.length === 1 && piecesOfItem[i]![0]!.value.flags >= 1,
  );
  const beamGroups: number[][] = [];
  const beamGroupOfItem = items.map(() => -1);
  let current: number[] = [];
  const flush = (): void => {
    if (current.length >= 2) {
      for (const i of current) beamGroupOfItem[i] = beamGroups.length;
      beamGroups.push(current);
    }
    current = [];
  };
  items.forEach((item, i) => {
    if (!eligible[i]) {
      flush();
      return;
    }
    const joinsPrevious =
      current.length > 0 &&
      item.beamedToPrevious &&
      piecesOfItem[i]![0]!.bar === piecesOfItem[current[current.length - 1]!]![0]!.bar;
    if (!joinsPrevious) flush();
    current.push(i);
  });
  flush();

  // Stem direction is decided per group: beamed notes and the notes of one tuplet share a direction.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    for (let node = i; parent[node] !== root;) {
      const next = parent[node]!;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  for (const group of beamGroups)
    for (let k = 1; k < group.length; k += 1) union(group[0]!, group[k]!);
  const tupletFirstNote = new Map<number, number>();
  items.forEach((item, i) => {
    if (!isNote(item) || item.tuplet === undefined) return;
    const first = tupletFirstNote.get(item.tuplet.id);
    if (first === undefined) tupletFirstNote.set(item.tuplet.id, i);
    else union(first, i);
  });
  const below = new Map<number, number>();
  const above = new Map<number, number>();
  items.forEach((item, i) => {
    if (!isNote(item)) return;
    const root = find(i);
    const offset = positions[i]! - 4;
    if (offset < 0) below.set(root, Math.max(below.get(root) ?? 0, -offset));
    else above.set(root, Math.max(above.get(root) ?? 0, offset));
  });
  // Up only if the farthest head is *below* the middle line (a tie goes down, like a lone note on the middle line).
  const stemUp = items.map((_, i) => {
    const root = find(i);
    return (below.get(root) ?? 0) > (above.get(root) ?? 0);
  });

  const barElementsMutable = new Map<number, AbcBarElement[]>();
  for (const element of piece.elements) {
    if (element.type !== 'bar') continue;
    const list = barElementsMutable.get(element.after) ?? [];
    list.push(element);
    barElementsMutable.set(element.after, list);
  }

  return {
    barCount,
    barStarts,
    endWhole,
    items,
    piecesByBar,
    positions,
    stemUp,
    beamGroups,
    beamGroupOfItem,
    keyEvents: piece.elements.filter((e): e is AbcKeyElement => e.type === 'key'),
    meterEvents: piece.elements.filter((e): e is AbcMeterElement => e.type === 'meter'),
    barElements: barElementsMutable,
    accidentals: computeDisplayAccidentals(piece),
  };
}

function barEnd(index: ScoreIndex, bar: number): number {
  return bar + 1 < index.barCount ? index.barStarts[bar + 1]! : index.endWhole;
}

/** The bar a position in the piece falls in (the last bar whose start is at or before it), clamped into the piece. */
export function barIndexAtWhole(piece: AbcPiece, whole: number): number {
  const index = indexOf(piece);
  if (!Number.isFinite(whole)) return whole > 0 ? index.barCount - 1 : 0;
  let low = 0;
  let high = index.barCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (index.barStarts[mid]! <= whole + WHOLE_EPSILON) low = mid;
    else high = mid - 1;
  }
  return low;
}

// --- Key and meter in force ----------------------------------------------------------------

function keyAt(piece: AbcPiece, index: ScoreIndex, whole: number, inclusive: boolean): KeyOffsets {
  let key = piece.keyAtStart;
  for (const event of index.keyEvents) {
    if (inclusive ? event.at <= whole + WHOLE_EPSILON : event.at < whole - WHOLE_EPSILON) {
      key = event.offsets;
    }
  }
  return key;
}

function meterAt(piece: AbcPiece, index: ScoreIndex, whole: number, inclusive: boolean): AbcMeter {
  let meter = piece.meter;
  for (const event of index.meterEvents) {
    if (inclusive ? event.at <= whole + WHOLE_EPSILON : event.at < whole - WHOLE_EPSILON) {
      meter = event.meter;
    }
  }
  return meter;
}

function sameMeter(a: AbcMeter, b: AbcMeter): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator && a.symbol === b.symbol;
}

function sameDisplayedKey(a: KeyOffsets, b: KeyOffsets): boolean {
  const da = displayedKeyOffsets(a);
  const db = displayedKeyOffsets(b);
  return (Object.keys(da) as (keyof KeyOffsets)[]).every((letter) => da[letter] === db[letter]);
}

// =================================================================================
// Signatures
// =================================================================================

/** y (staff spaces, top line = 0) of a staff position. */
function positionY(position: number): number {
  return (8 - position) / 2;
}

interface TimeSigPart {
  readonly glyph: StaffGlyphName;
  readonly dx: number;
  readonly y: number;
}

function timeSignatureParts(meter: AbcMeter): { width: number; parts: TimeSigPart[] } {
  if (meter.symbol === 'common' || meter.symbol === 'cut') {
    const glyph = meter.symbol === 'common' ? 'timeSigCommon' : 'timeSigCutCommon';
    return { width: STAFF_GLYPHS[glyph].width, parts: [{ glyph, dx: 0, y: 2 }] };
  }
  const row = (n: number, y: number) => {
    const glyphs = String(Math.max(0, Math.trunc(n)))
      .split('')
      .map((d) => `timeSig${d}` as StaffGlyphName);
    const width = glyphs.reduce((w, g) => w + STAFF_GLYPHS[g].width, 0);
    return { glyphs, width, y };
  };
  const top = row(meter.numerator, 1);
  const bottom = row(meter.denominator, 3);
  const width = Math.max(top.width, bottom.width);
  const parts: TimeSigPart[] = [];
  for (const r of [top, bottom]) {
    let dx = (width - r.width) / 2;
    for (const glyph of r.glyphs) {
      parts.push({ glyph, dx, y: r.y });
      dx += STAFF_GLYPHS[glyph].width;
    }
  }
  return { width, parts };
}

function keySignatureWidth(glyphs: readonly KeySignatureAccidental[]): number {
  if (glyphs.length === 0) return 0;
  return (
    glyphs.reduce((w, g) => w + STAFF_GLYPHS[g.glyph].width, 0) +
    (glyphs.length - 1) * KEY_GLYPH_GAP
  );
}

/** A key and/or meter change drawn inside the staff (at a bar start or, rarely, inside a bar). */
interface SignatureChange {
  readonly key: readonly KeySignatureAccidental[];
  readonly meter: AbcMeter | undefined;
  readonly width: number;
}

function makeSignatureChange(
  key: readonly KeySignatureAccidental[],
  meter: AbcMeter | undefined,
): SignatureChange | undefined {
  if (key.length === 0 && meter === undefined) return undefined;
  let width = keySignatureWidth(key);
  if (meter !== undefined) {
    width += (key.length > 0 ? KEY_TO_TIME : 0) + timeSignatureParts(meter).width;
  }
  return { key, meter, width };
}

/** The key/meter changes that happen in `[from, to)` of the piece, as one change (or none). */
function signatureChangeIn(
  piece: AbcPiece,
  index: ScoreIndex,
  from: number,
  to: number,
): SignatureChange | undefined {
  const inside = (at: number) => at >= from - WHOLE_EPSILON && at < to - WHOLE_EPSILON;
  const keyEvent = [...index.keyEvents].reverse().find((e) => inside(e.at));
  const meterEvent = [...index.meterEvents].reverse().find((e) => inside(e.at));
  let key: readonly KeySignatureAccidental[] = [];
  if (keyEvent !== undefined) {
    const before = keyAt(piece, index, keyEvent.at, false);
    if (!sameDisplayedKey(before, keyEvent.offsets)) {
      key = keySignatureGlyphs(keyEvent.offsets, before);
    }
  }
  let meter: AbcMeter | undefined;
  if (meterEvent !== undefined) {
    const before = meterAt(piece, index, meterEvent.at, false);
    if (!sameMeter(before, meterEvent.meter)) meter = meterEvent.meter;
  }
  return makeSignatureChange(key, meter);
}

// =================================================================================
// Bar lines
// =================================================================================

interface ClusterShape {
  readonly lines: readonly { readonly dx: number; readonly width: number }[];
  readonly dots: readonly number[];
  /** How far the cluster extends left / right of its anchor x. */
  readonly left: number;
  readonly right: number;
}

const THIN = E.thinBarlineThickness;
const THICK = E.thickBarlineThickness;
const BAR_SEP = E.barlineSeparation;
const THIN_THICK_SEP = E.thinThickBarlineSeparation;
const REPEAT_DOT_SEP = E.repeatBarlineDotSeparation;
const REPEAT_DOT_CENTER = REPEAT_DOT_SEP + DOT_RADIUS;

function clusterShape(style: AbcBarStyle): ClusterShape {
  switch (style) {
    case 'single':
      return { lines: [{ dx: 0, width: THIN }], dots: [], left: THIN / 2, right: THIN / 2 };
    case 'double': {
      const d = (BAR_SEP + THIN) / 2;
      return {
        lines: [
          { dx: -d, width: THIN },
          { dx: d, width: THIN },
        ],
        dots: [],
        left: d + THIN / 2,
        right: d + THIN / 2,
      };
    }
    case 'final': {
      const thick = THIN / 2 + THIN_THICK_SEP + THICK / 2;
      return {
        lines: [
          { dx: 0, width: THIN },
          { dx: thick, width: THICK },
        ],
        dots: [],
        left: THIN / 2,
        right: thick + THICK / 2,
      };
    }
    case 'repeat-start': {
      const thin = THICK / 2 + THIN_THICK_SEP + THIN / 2;
      const dot = thin + THIN / 2 + REPEAT_DOT_CENTER;
      return {
        lines: [
          { dx: 0, width: THICK },
          { dx: thin, width: THIN },
        ],
        dots: [dot],
        left: THICK / 2,
        right: dot + DOT_RADIUS,
      };
    }
    case 'repeat-end': {
      const thin = THICK / 2 + THIN_THICK_SEP + THIN / 2;
      const dot = thin + THIN / 2 + REPEAT_DOT_CENTER;
      return {
        lines: [
          { dx: -thin, width: THIN },
          { dx: 0, width: THICK },
        ],
        dots: [-dot],
        left: dot + DOT_RADIUS,
        right: THICK / 2,
      };
    }
    case 'repeat-both': {
      const d = (BAR_SEP + THIN) / 2;
      const dot = d + THIN / 2 + REPEAT_DOT_CENTER;
      return {
        lines: [
          { dx: -d, width: THIN },
          { dx: d, width: THIN },
        ],
        dots: [-dot, dot],
        left: dot + DOT_RADIUS,
        right: dot + DOT_RADIUS,
      };
    }
  }
}

// =================================================================================
// Bars: content and horizontal placement
// =================================================================================

interface BarContent {
  readonly bar: number;
  readonly startWhole: number;
  readonly endWhole: number;
  readonly pieces: readonly PieceDesc[];
  /** Key/meter change at the very start of the bar (not for the window's first bar, whose signatures are in the preamble). */
  readonly leadSignature: SignatureChange | undefined;
  /** Changes inside the bar, keyed by the index of the piece they precede. */
  readonly midSignatures: ReadonlyMap<number, SignatureChange>;
  readonly closingStyle: AbcBarStyle;
  /** A rest that fills the bar on its own: drawn as a whole rest, centered. */
  readonly wholeBarRest: boolean;
}

function closingStyleOf(index: ScoreIndex, bar: number): AbcBarStyle {
  const elements = index.barElements.get(bar);
  if (elements !== undefined && elements.length > 0) return mergeBarStyles(elements);
  return bar >= index.barCount - 1 ? 'final' : 'single';
}

/** The repeat sign (if any) that opens the window: a `|:` that ends the bar before it. */
function openingStyleOf(index: ScoreIndex, firstBar: number): AbcBarStyle | undefined {
  const elements = index.barElements.get(firstBar - 1);
  if (elements === undefined || elements.length === 0) return undefined;
  const style = mergeBarStyles(elements);
  return style === 'repeat-start' || style === 'repeat-both' ? 'repeat-start' : undefined;
}

function buildBarContent(
  piece: AbcPiece,
  index: ScoreIndex,
  bar: number,
  isFirstInWindow: boolean,
): BarContent {
  const startWhole = index.barStarts[bar]!;
  const endWhole = barEnd(index, bar);
  const pieces = index.piecesByBar[bar]!;

  const leadSignature = isFirstInWindow
    ? undefined
    : signatureChangeIn(piece, index, startWhole, startWhole + 2 * WHOLE_EPSILON);

  const midSignatures = new Map<number, SignatureChange>();
  const midFrom = startWhole + 2 * WHOLE_EPSILON;
  if (endWhole > midFrom + WHOLE_EPSILON && pieces.length > 0) {
    // Group mid-bar changes by the piece they precede.
    const eventTimes = new Set<number>();
    for (const e of index.keyEvents)
      if (e.at > midFrom && e.at < endWhole - WHOLE_EPSILON) eventTimes.add(e.at);
    for (const e of index.meterEvents)
      if (e.at > midFrom && e.at < endWhole - WHOLE_EPSILON) eventTimes.add(e.at);
    for (const at of [...eventTimes].sort((a, b) => a - b)) {
      const before = pieces.findIndex((p) => p.start >= at - WHOLE_EPSILON);
      if (before <= 0) continue;
      const change = signatureChangeIn(piece, index, at, at + 2 * WHOLE_EPSILON);
      if (change !== undefined && !midSignatures.has(before)) midSignatures.set(before, change);
    }
  }

  let wholeBarRest = false;
  if (pieces.length === 1) {
    const only = pieces[0]!;
    const meter = meterAt(piece, index, startWhole, true);
    wholeBarRest =
      !isNote(only.item) &&
      sameWhole(only.start, startWhole) &&
      Math.abs(only.sound - meter.barLengthWhole) <= 1e-6 &&
      Math.abs(endWhole - startWhole - meter.barLengthWhole) <= 1e-6;
  }

  return {
    bar,
    startWhole,
    endWhole,
    pieces,
    leadSignature,
    midSignatures,
    closingStyle: closingStyleOf(index, bar),
    wholeBarRest,
  };
}

interface PlacedPiece {
  readonly desc: PieceDesc;
  readonly x: number;
  /** Width of the head or rest glyph. */
  readonly w: number;
  readonly isRest: boolean;
  readonly visible: boolean;
  readonly value: NoteValue;
  readonly position: number;
  readonly y: number;
  readonly stemUp: boolean;
  readonly accidental: number | undefined;
  readonly beamed: boolean;
}

interface PlacedSignature {
  readonly x: number;
  readonly change: SignatureChange;
}

interface BarFrame {
  readonly content: BarContent;
  readonly x0: number;
  readonly pieces: readonly PlacedPiece[];
  readonly signatures: readonly PlacedSignature[];
  readonly closingX: number;
  readonly closing: ClusterShape;
  /** x where the next bar starts (right edge of the closing cluster). */
  readonly right: number;
  /** x center for a whole-bar rest. */
  readonly restCenterX: number;
}

function accidentalGlyphOf(accidental: number): StaffGlyphName | undefined {
  switch (accidental) {
    case 1:
      return 'accidentalSharp';
    case -1:
      return 'accidentalFlat';
    case 0:
      return 'accidentalNatural';
    case 2:
      return 'accidentalDoubleSharp';
    case -2:
      return 'accidentalDoubleFlat';
    default:
      return undefined;
  }
}

function headGlyphOf(value: NoteValue): StaffGlyphName {
  if (value.base >= 1) return 'noteheadWhole';
  if (value.base >= 1 / 2) return 'noteheadHalf';
  return 'noteheadBlack';
}

function restGlyphOf(value: NoteValue): StaffGlyphName {
  switch (value.base) {
    case 1:
      return 'restWhole';
    case 1 / 2:
      return 'restHalf';
    case 1 / 4:
      return 'restQuarter';
    case 1 / 8:
      return 'rest8th';
    case 1 / 16:
      return 'rest16th';
    default:
      return 'rest32nd';
  }
}

function flagGlyphName(flags: number, up: boolean): StaffGlyphName {
  const name = flags === 1 ? '8th' : flags === 2 ? '16th' : '32nd';
  return `flag${name}${up ? 'Up' : 'Down'}` as StaffGlyphName;
}

/** Horizontal room a dotted piece's dots need to the right of its head. */
function dotsExtent(dots: number): number {
  return dots === 0 ? 0 : DOT_GAP + DOT_RADIUS + (dots - 1) * DOT_STEP;
}

/**
 * Assigns x positions inside one bar, starting at `x0`. `stretch` >= 1 widens
 * the duration-proportional gaps (justification); the fixed paddings do not
 * stretch.
 */
function placeBar(
  index: ScoreIndex,
  content: BarContent,
  x0: number,
  stretch: number,
  isWindowStart: boolean,
): BarFrame {
  const closing = clusterShape(content.closingStyle);
  const signatures: PlacedSignature[] = [];

  let cursor = x0;
  if (content.leadSignature !== undefined) {
    cursor += SIG_PAD;
    signatures.push({ x: cursor, change: content.leadSignature });
    cursor += content.leadSignature.width;
  }
  // A note tied in from the previous window leaves its tie's end hanging off the left edge: give it room to be seen.
  const continuesTie = isWindowStart && (content.pieces[0]?.indexInItem ?? 0) > 0;
  const startPad =
    content.leadSignature !== undefined
      ? AFTER_SIGNATURE_PAD
      : isWindowStart
        ? PREAMBLE_PAD
        : START_PAD;
  const contentLeft = cursor + startPad + (continuesTie ? TIE_STUB : 0);

  const placed: PlacedPiece[] = [];
  let previous: PlacedPiece | undefined;
  let previousRightExtent = 0;
  let x = contentLeft;

  content.pieces.forEach((desc, i) => {
    const item = desc.item;
    const note = isNote(item);
    const wholeRest = content.wholeBarRest;
    const value: NoteValue = wholeRest ? { base: 1, dots: 0, whole: 1, flags: 0 } : desc.value;
    const glyph = note ? headGlyphOf(value) : restGlyphOf(value);
    const w = STAFF_GLYPHS[glyph].width;
    const position = index.positions[desc.itemIndex]!;
    const stemUp = index.stemUp[desc.itemIndex]!;
    const beamed = index.beamGroupOfItem[desc.itemIndex]! >= 0;
    const accidental =
      note && desc.indexInItem === 0
        ? index.accidentals.get((item as AbcNoteElement).noteIndex)
        : undefined;
    const accGlyph = accidental === undefined ? undefined : accidentalGlyphOf(accidental);
    const accRoom = accGlyph === undefined ? 0 : STAFF_GLYPHS[accGlyph].width + ACCIDENTAL_GAP;

    // How far this piece reaches right of its x: head, dots, and (up-stem flags) the flag.
    const flaggedUp = note && !beamed && value.flags > 0 && stemUp;
    let rightExtent =
      w +
      dotsExtent(wholeRest ? 0 : value.dots) +
      (flaggedUp && !wholeRest && value.dots > 0 ? FLAG_DOT_CLEARANCE : 0);
    if (flaggedUp) {
      const flag = STAFF_GLYPHS[flagGlyphName(value.flags, true)];
      rightExtent = Math.max(
        rightExtent,
        SMUFL_ANCHORS.noteheadBlack.stemUpSE[0] - STEM_W + flag.width,
      );
    }

    const signature = content.midSignatures.get(i);
    if (previous !== undefined) {
      const natural = spaceForDuration(previous.desc.sound);
      let minGap = previousRightExtent + CLEAR + accRoom;
      let sigX = 0;
      if (signature !== undefined) {
        minGap += SIG_PAD + signature.width + SIG_PAD;
        sigX = previous.x + previousRightExtent + SIG_PAD;
      }
      const stretchedGap = natural * stretch;
      const gap = Math.max(stretchedGap, minGap);
      x = previous.x + gap;
      if (signature !== undefined) signatures.push({ x: sigX, change: signature });
    } else {
      x = contentLeft + accRoom;
    }

    const piecePlaced: PlacedPiece = {
      desc,
      x,
      w,
      isRest: !note,
      visible: note || (item as AbcRestElement).visible,
      value,
      position,
      y: positionY(position),
      stemUp,
      accidental: accGlyph === undefined ? undefined : accidental,
      beamed,
    };
    placed.push(piecePlaced);
    previous = piecePlaced;
    previousRightExtent = rightExtent;
  });

  let closingX: number;
  if (previous === undefined) {
    closingX = x0 + EMPTY_BAR_WIDTH;
  } else {
    const natural = Math.max(0, spaceForDuration(previous.desc.sound) - BAR_GAP);
    const minClose = previousRightExtent + CLEAR + closing.left;
    closingX = previous.x + Math.max(natural * stretch, minClose);
  }

  const restLeft = contentLeft;
  const restRight = closingX - closing.left - 0.6;
  return {
    content,
    x0,
    pieces: placed,
    signatures,
    closingX,
    closing,
    right: closingX + closing.right,
    restCenterX: (restLeft + Math.max(restLeft, restRight)) / 2,
  };
}

// =================================================================================
// Primitive emission
// =================================================================================

class Primitives {
  readonly list: ScorePrimitive[] = [];

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    part: ScorePart,
    noteIndex?: number,
  ): void {
    this.list.push(
      noteIndex === undefined
        ? { kind: 'line', x1, y1, x2, y2, width, part }
        : { kind: 'line', x1, y1, x2, y2, width, part, noteIndex },
    );
  }

  glyph(glyph: StaffGlyphName, x: number, y: number, part: ScorePart, noteIndex?: number): void {
    this.list.push(
      noteIndex === undefined
        ? { kind: 'glyph', glyph, x, y, part }
        : { kind: 'glyph', glyph, x, y, part, noteIndex },
    );
  }

  polygon(points: readonly (readonly [number, number])[], part: ScorePart): void {
    this.list.push({ kind: 'polygon', points, part });
  }

  path(d: string, width: number, filled: boolean, part: ScorePart, noteIndex?: number): void {
    this.list.push(
      noteIndex === undefined
        ? { kind: 'path', d, width, filled, part }
        : { kind: 'path', d, width, filled, part, noteIndex },
    );
  }

  circle(cx: number, cy: number, r: number, part: ScorePart): void {
    this.list.push({ kind: 'circle', cx, cy, r, part });
  }
}

const f = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};

function emitBarCluster(out: Primitives, shape: ClusterShape, x: number): void {
  for (const line of shape.lines) {
    out.line(
      x + line.dx,
      -STAFF_LINE_W / 2,
      x + line.dx,
      4 + STAFF_LINE_W / 2,
      line.width,
      'bar-line',
    );
  }
  for (const dx of shape.dots) {
    out.circle(x + dx, 1.5, DOT_RADIUS, 'bar-line');
    out.circle(x + dx, 2.5, DOT_RADIUS, 'bar-line');
  }
}

function emitKeySignature(
  out: Primitives,
  glyphs: readonly KeySignatureAccidental[],
  x: number,
): number {
  let cursor = x;
  for (const g of glyphs) {
    out.glyph(g.glyph, cursor, positionY(g.position), 'key-signature');
    cursor += STAFF_GLYPHS[g.glyph].width + KEY_GLYPH_GAP;
  }
  return cursor - KEY_GLYPH_GAP;
}

function emitTimeSignature(out: Primitives, meter: AbcMeter, x: number): number {
  const { width, parts } = timeSignatureParts(meter);
  for (const part of parts) out.glyph(part.glyph, x + part.dx, part.y, 'time-signature');
  return x + width;
}

function emitSignatureChange(out: Primitives, change: SignatureChange, x: number): void {
  let cursor = x;
  if (change.key.length > 0) cursor = emitKeySignature(out, change.key, cursor);
  if (change.meter !== undefined) {
    emitTimeSignature(out, change.meter, cursor + (change.key.length > 0 ? KEY_TO_TIME : 0));
  }
}

/** A tie as a filled crescent from (x1, y0) to (x2, y0) bulging toward `side` (+1 = down, -1 = up). */
function tieCrescent(x1: number, x2: number, y0: number, side: 1 | -1): string {
  const length = Math.max(0.3, x2 - x1);
  const height = Math.min(1.1, Math.max(0.45, 0.35 + 0.075 * length));
  const endThickness = E.tieEndpointThickness;
  const midThickness = E.tieMidpointThickness;
  const outer = height / 0.75;
  const inner = (height - midThickness + endThickness) / 0.75;
  const reach = length * 0.27;
  const yo = y0 + side * outer;
  const yi = y0 - side * endThickness + side * inner;
  return (
    `M${f(x1)} ${f(y0)}C${f(x1 + reach)} ${f(yo)} ${f(x2 - reach)} ${f(yo)} ${f(x2)} ${f(y0)}` +
    `L${f(x2)} ${f(y0 - side * endThickness)}` +
    `C${f(x2 - reach)} ${f(yi)} ${f(x1 + reach)} ${f(yi)} ${f(x1)} ${f(y0 - side * endThickness)}Z`
  );
}

interface BeamMember {
  readonly piece: PlacedPiece;
  readonly stemX: number;
  readonly headY: number;
  readonly beams: number;
}

/** Placement of one beam group's outer beam edge: y(x) = b0 + slope * (x - x0). */
interface BeamLine {
  readonly x0: number;
  readonly b0: number;
  readonly slope: number;
  readonly up: boolean;
}

function beamY(line: BeamLine, x: number): number {
  return line.b0 + line.slope * (x - line.x0);
}

/** Snap a flat beam so it sits on, hangs from or straddles a staff line (never floats in the middle of a space). */
function snapFlatBeam(b0: number, up: boolean): number {
  const fractions = up ? [0, 0.5, 0.75] : [0, 0.25, 0.5];
  const base = Math.floor(b0);
  const candidates: number[] = [];
  for (let k = base - 1; k <= base + 1; k += 1) for (const fr of fractions) candidates.push(k + fr);
  if (up) {
    // Outer edge is the top: only move upward (smaller y) so stems never get shorter.
    return Math.max(...candidates.filter((c) => c <= b0 + 1e-6));
  }
  return Math.min(...candidates.filter((c) => c >= b0 - 1e-6));
}

function computeBeamLine(members: readonly BeamMember[], up: boolean): BeamLine {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const dx = last.stemX - first.stemX;
  const beams = members.reduce((m, member) => Math.max(m, member.beams), 1);

  // Slope follows the melody (damped), but a group that goes up and comes back is flat.
  let slope = 0;
  const steps = members.slice(1).map((m, k) => m.headY - members[k]!.headY);
  const rises = steps.some((s) => s < -0.01);
  const falls = steps.some((s) => s > 0.01);
  if (dx > 0 && rises !== falls) {
    slope = ((last.headY - first.headY) / dx) * BEAM_SLOPE_DAMPING;
    slope = Math.max(-MAX_BEAM_SLOPE, Math.min(MAX_BEAM_SLOPE, slope));
  }

  // Beams add 0.5 to the stem for each beam after the first, so the notes stay clear of the stack.
  const length = STEM_LENGTH + 0.5 * (beams - 1);
  let b0 = up ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const m of members) {
    const along = slope * (m.stemX - first.stemX);
    if (up) {
      b0 = Math.min(b0, m.headY - length - along, MIDDLE_LINE_Y - along);
    } else {
      b0 = Math.max(b0, m.headY + length - along, MIDDLE_LINE_Y - along);
    }
  }
  if (slope === 0) b0 = snapFlatBeam(b0, up);
  return { x0: first.stemX, b0, slope, up };
}

// =================================================================================
// The layout
// =================================================================================

interface PreambleInfo {
  readonly keyGlyphs: readonly KeySignatureAccidental[];
  readonly keyX: number;
  readonly meter: AbcMeter | undefined;
  readonly meterX: number;
  readonly end: number;
}

function buildPreamble(
  piece: AbcPiece,
  index: ScoreIndex,
  firstBar: number,
  showTime: boolean,
): PreambleInfo {
  const startWhole = index.barStarts[firstBar]!;
  const keyGlyphs = keySignatureGlyphs(keyAt(piece, index, startWhole, true));
  let x = CLEF_X + STAFF_GLYPHS.gClef.width;
  const keyX = x + CLEF_TO_KEY;
  if (keyGlyphs.length > 0) x = keyX + keySignatureWidth(keyGlyphs);
  const meter = showTime ? meterAt(piece, index, startWhole, true) : undefined;
  const meterX = x + (keyGlyphs.length > 0 ? KEY_TO_TIME : CLEF_TO_KEY);
  if (meter !== undefined) x = meterX + timeSignatureParts(meter).width;
  return { keyGlyphs, keyX, meter, meterX, end: x };
}

function defaultShowTimeSignature(piece: AbcPiece, index: ScoreIndex, firstBar: number): boolean {
  // A file with no M: line is read as 4/4 so it can be played, but it never said 4/4: printing a time signature the music did not give would be inventing one.
  if (firstBar === 0) return !piece.meterAssumed;
  const startWhole = index.barStarts[firstBar]!;
  return !sameMeter(
    meterAt(piece, index, startWhole, false),
    meterAt(piece, index, startWhole, true),
  );
}

function clampBarOption(value: number, barCount: number): number {
  const bar = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(barCount - 1, Math.max(0, bar));
}

interface Anchor {
  readonly whole: number;
  readonly x: number;
}

export function layoutScore(piece: AbcPiece, options: ScoreLayoutOptions): ScoreLayout {
  const index = indexOf(piece);
  const firstBar = clampBarOption(options.firstBar, index.barCount);
  // An infinite width means "no limit" (every bar, up to maxBars); NaN and negative widths mean "no room" (one bar, overflowing).
  const widthOption =
    options.widthSpaces === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.widthSpaces)
        ? Math.max(0, options.widthSpaces)
        : 0;
  const maxBars =
    options.maxBars !== undefined && Number.isFinite(options.maxBars)
      ? Math.max(1, Math.trunc(options.maxBars))
      : Number.POSITIVE_INFINITY;
  const showTime = options.showTimeSignature ?? defaultShowTimeSignature(piece, index, firstBar);

  const preamble = buildPreamble(piece, index, firstBar, showTime);
  const openingStyle = openingStyleOf(index, firstBar);
  const openingShape = openingStyle === undefined ? undefined : clusterShape(openingStyle);
  const openingAnchor = preamble.end + OPENING_GAP + (openingShape?.left ?? 0);
  const firstX0 = openingShape === undefined ? preamble.end : openingAnchor + openingShape.right;

  // --- Choose the bars that fit, at natural spacing. ---
  const contents: BarContent[] = [];
  let x0 = firstX0;
  let neededWidth = firstX0 + END_MARGIN;
  let overflow = false;
  for (let bar = firstBar; bar < index.barCount && contents.length < maxBars; bar += 1) {
    const content = buildBarContent(piece, index, bar, bar === firstBar);
    const frame = placeBar(index, content, x0, 1, bar === firstBar);
    const needed = frame.right + END_MARGIN;
    if (contents.length === 0) {
      overflow = needed > widthOption + 1e-6;
    } else if (needed > widthOption + 1e-6) {
      break;
    }
    contents.push(content);
    neededWidth = needed;
    x0 = frame.right;
  }
  const lastBar = firstBar + contents.length - 1;

  // --- Justify: widen the proportional gaps so the line is full (not for the last window of a piece). ---
  const placeAll = (stretch: number): BarFrame[] => {
    const placed: BarFrame[] = [];
    let at = firstX0;
    for (const content of contents) {
      const frame = placeBar(index, content, at, stretch, content.bar === firstBar);
      placed.push(frame);
      at = frame.right;
    }
    return placed;
  };
  const rightOf = (placed: readonly BarFrame[]): number =>
    placed[placed.length - 1]!.right + END_MARGIN;
  let stretch = 1;
  if (
    options.justify !== false &&
    !overflow &&
    Number.isFinite(widthOption) &&
    lastBar < index.barCount - 1
  ) {
    // The widest stretch that still fits (the right edge only grows with it, so bisect).
    let low = 1;
    let high = MAX_STRETCH;
    if (rightOf(placeAll(high)) <= widthOption) {
      low = high;
    } else {
      for (let step = 0; step < 14; step += 1) {
        const mid = (low + high) / 2;
        if (rightOf(placeAll(mid)) <= widthOption) low = mid;
        else high = mid;
      }
    }
    stretch = low;
  }

  const frames = placeAll(stretch);
  const contentRight = rightOf(frames);
  const width = Number.isFinite(widthOption) ? Math.max(widthOption, contentRight) : contentRight;

  // --- Emit primitives in draw order. ---
  const out = new Primitives();
  const barLines: ScoreBarLine[] = [];
  const noteRecords = new Map<number, { first: PlacedPiece; pieces: number }>();
  const anchors: Anchor[] = [];

  for (const y of [0, 1, 2, 3, 4]) out.line(0, y, width, y, STAFF_LINE_W, 'staff-line');
  out.glyph('gClef', CLEF_X, 3, 'clef');
  if (preamble.keyGlyphs.length > 0) emitKeySignature(out, preamble.keyGlyphs, preamble.keyX);
  if (preamble.meter !== undefined) emitTimeSignature(out, preamble.meter, preamble.meterX);

  if (openingShape !== undefined) {
    emitBarCluster(out, openingShape, openingAnchor);
    barLines.push({ x: openingAnchor, bar: firstBar - 1 });
  }
  for (const frame of frames) {
    emitBarCluster(out, frame.closing, frame.closingX);
    barLines.push({ x: frame.closingX, bar: frame.content.bar });
  }

  // Placed pieces by (item, piece) for ties across bars.
  const placedByKey = new Map<string, PlacedPiece>();
  for (const frame of frames) {
    for (const p of frame.pieces) placedByKey.set(`${p.desc.itemIndex}:${p.desc.indexInItem}`, p);
  }

  for (const frame of frames) {
    for (const s of frame.signatures) emitSignatureChange(out, s.change, s.x);
    emitBarContents(
      out,
      index,
      frame,
      placedByKey,
      noteRecords,
      firstX0,
      frame.x0,
      options.fingers,
    );
    for (const p of frame.pieces) {
      // Notes anchor on the center of their head. Rests anchor on the same nominal column (a whole-bar rest is drawn centered, but the playhead still starts at the bar's left).
      anchors.push({
        whole: Math.max(p.desc.start, frame.content.startWhole),
        x: p.isRest ? p.x + HEAD_BLACK / 2 : p.x + p.w / 2,
      });
    }
  }

  // --- Tidy up the playhead anchors: sorted, strictly increasing in whole, never decreasing in x. ---
  const lastFrame = frames[frames.length - 1]!;
  anchors.sort((a, b) => a.whole - b.whole || a.x - b.x);
  const endWhole = lastFrame.content.endWhole;
  anchors.push({
    whole: Math.max(endWhole, anchors.length ? anchors[anchors.length - 1]!.whole : 0),
    x: lastFrame.closingX,
  });
  const xForWhole = makeXForWhole(anchors, lastFrame.closingX);

  // --- Notes shown. ---
  const notes: ScoreNoteLayout[] = [...noteRecords.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([noteIndex, rec]) => ({
      noteIndex,
      x: rec.first.x,
      xCenter: rec.first.x + rec.first.w / 2,
      y: rec.first.y,
      stemUp: rec.first.stemUp,
      pieces: rec.pieces,
    }));

  // --- View box: the default vertical range, grown to fit anything that goes beyond it. ---
  let minY = DEFAULT_MIN_Y;
  let maxY = DEFAULT_MAX_Y;
  for (const primitive of out.list) {
    const b = primitiveBounds(primitive);
    minY = Math.min(minY, b[1] - EXTENT_MARGIN);
    maxY = Math.max(maxY, b[3] + EXTENT_MARGIN);
  }

  return {
    viewBox: [0, minY, width, maxY - minY],
    primitives: out.list,
    firstBar,
    lastBar,
    overflow,
    widthSpaces: neededWidth,
    notes,
    barLines,
    xForWhole,
  };
}

function makeXForWhole(anchors: readonly Anchor[], rightEnd: number): (whole: number) => number {
  // Strictly increasing wholes (equal positions keep the leftmost x) and non-decreasing x.
  const pts: Anchor[] = [];
  for (const a of anchors) {
    const last = pts[pts.length - 1];
    if (last !== undefined && a.whole <= last.whole + WHOLE_EPSILON) continue;
    pts.push({ whole: a.whole, x: Math.max(a.x, last?.x ?? Number.NEGATIVE_INFINITY) });
  }
  return (whole: number): number => {
    if (pts.length === 0) return rightEnd;
    if (!Number.isFinite(whole)) return whole > 0 ? rightEnd : pts[0]!.x;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (whole <= first.whole) return first.x;
    if (whole >= last.whole) return Math.max(last.x, rightEnd);
    let low = 0;
    let high = pts.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (pts[mid]!.whole <= whole) low = mid;
      else high = mid;
    }
    const a = pts[low]!;
    const b = pts[high]!;
    return a.x + ((whole - a.whole) / (b.whole - a.whole)) * (b.x - a.x);
  };
}

// =================================================================================
// Drawing the contents of one bar
// =================================================================================

function emitBarContents(
  out: Primitives,
  index: ScoreIndex,
  frame: BarFrame,
  placedByKey: ReadonlyMap<string, PlacedPiece>,
  noteRecords: Map<number, { first: PlacedPiece; pieces: number }>,
  windowStartX: number,
  barStartX: number,
  fingers?: readonly (FingerMark | undefined)[],
): void {
  const stemTip = new Map<PlacedPiece, number>();
  const stemXOf = (p: PlacedPiece): number =>
    p.stemUp
      ? p.x + SMUFL_ANCHORS.noteheadBlack.stemUpSE[0] - STEM_W / 2
      : p.x + SMUFL_ANCHORS.noteheadBlack.stemDownNW[0] + STEM_W / 2;

  // Heads, ledger lines, accidentals, dots, rests.
  for (const p of frame.pieces) {
    const item = p.desc.item;
    if (p.isRest) {
      if (!p.visible) continue;
      emitRest(out, p, frame);
      continue;
    }
    const noteIndex = (item as AbcNoteElement).noteIndex;
    const record = noteRecords.get(noteIndex);
    if (record === undefined) noteRecords.set(noteIndex, { first: p, pieces: 1 });
    else record.pieces += 1;

    for (const position of ledgerPositions(p.position)) {
      const y = positionY(position);
      out.line(
        p.x - LEDGER_EXTENSION,
        y,
        p.x + p.w + LEDGER_EXTENSION,
        y,
        E.legerLineThickness,
        'ledger-line',
        noteIndex,
      );
    }
    if (p.accidental !== undefined) {
      const glyph = accidentalGlyphOf(p.accidental)!;
      out.glyph(
        glyph,
        p.x - ACCIDENTAL_GAP - STAFF_GLYPHS[glyph].width,
        p.y,
        'accidental',
        noteIndex,
      );
    }
    out.glyph(headGlyphOf(p.value), p.x, p.y, 'head', noteIndex);
    // An up-stem flag curls down beside the head to about the height of the dot: nudge the dots right, clear of its tail.
    emitDots(out, p, p.x + p.w + dotShiftOf(p), p.position % 2 === 0 ? p.y - 0.5 : p.y, noteIndex);
  }

  // Beam groups in this bar: stems and beams together.
  const groupsHere = new Set<number>();
  for (const p of frame.pieces) {
    const g = index.beamGroupOfItem[p.desc.itemIndex]!;
    if (!p.isRest && g >= 0) groupsHere.add(g);
  }
  for (const g of groupsHere) {
    const members: BeamMember[] = index.beamGroups[g]!.map((itemIndex) =>
      frame.pieces.find((p) => p.desc.itemIndex === itemIndex),
    )
      .filter((p): p is PlacedPiece => p !== undefined)
      .map((p) => ({ piece: p, stemX: stemXOf(p), headY: p.y, beams: p.value.flags }));
    if (members.length < 2) continue;
    const up = members[0]!.piece.stemUp;
    const line = computeBeamLine(members, up);
    for (const m of members) {
      const tip = beamY(line, m.stemX);
      stemTip.set(m.piece, tip);
      emitStem(out, m.piece, m.stemX, tip);
    }
    emitBeams(out, members, line);
  }

  // Single stems (and flags) for every other note with a stem.
  for (const p of frame.pieces) {
    if (p.isRest || p.beamed || p.value.base >= 1) continue;
    const stemX = stemXOf(p);
    const length = STEM_LENGTH + 0.5 * Math.max(0, p.value.flags - 1);
    const tip = p.stemUp
      ? Math.min(p.y - length, MIDDLE_LINE_Y)
      : Math.max(p.y + length, MIDDLE_LINE_Y);
    stemTip.set(p, tip);
    emitStem(out, p, stemX, tip);
    if (p.value.flags > 0) {
      const glyph = flagGlyphName(p.value.flags, p.stemUp);
      const anchors = SMUFL_ANCHORS[glyph as keyof typeof SMUFL_ANCHORS] as Record<
        string,
        readonly [number, number]
      >;
      const anchor = p.stemUp ? anchors.stemUpNW! : anchors.stemDownSW!;
      out.glyph(
        glyph,
        stemX - STEM_W / 2 - anchor[0],
        tip - anchor[1],
        'flag',
        (p.desc.item as AbcNoteElement).noteIndex,
      );
    }
  }

  emitTies(out, frame, placedByKey, windowStartX, barStartX);
  emitTuplets(out, index, frame, stemTip, stemXOf);
  if (fingers !== undefined) emitFingers(out, frame, noteRecords, stemTip, fingers);
}

/** Finger numbers: a small digit centred over each note's (first) head, above its stem or beam and above the staff. */
function emitFingers(
  out: Primitives,
  frame: BarFrame,
  noteRecords: ReadonlyMap<number, { first: PlacedPiece }>,
  stemTip: ReadonlyMap<PlacedPiece, number>,
  fingers: readonly (FingerMark | undefined)[],
): void {
  for (const p of frame.pieces) {
    if (p.isRest) continue;
    const noteIndex = (p.desc.item as AbcNoteElement).noteIndex;
    if (noteRecords.get(noteIndex)?.first !== p) continue; // only a tied note's first head
    const mark = fingers[noteIndex];
    if (mark === undefined || !Number.isInteger(mark.finger)) continue;
    if (mark.finger < 0 || mark.finger > 4) continue;
    const glyph = `tuplet${mark.finger}` as StaffGlyphName;
    const [, dTop, , dBottom] = STAFF_GLYPHS[glyph].bounds;
    const digitHeight = dBottom - dTop;
    // Bottom edge of the digit: over the staff, over the head (room for a tie), over a stem or beam.
    const edge = Math.min(FINGER_STAFF_CLEARANCE, p.y - FINGER_HEAD_CLEARANCE, stemTip.get(p) ?? 0);
    const centerY = edge - FINGER_STEM_CLEARANCE - digitHeight / 2;
    out.glyph(
      glyph,
      p.x + p.w / 2 - STAFF_GLYPHS[glyph].width / 2,
      centerY - (dTop + dBottom) / 2,
      'finger',
      noteIndex,
    );
  }
}

/** Finger numbers sit at least this far above the top staff line, above a head, and above a stem tip (staff spaces). */
const FINGER_STAFF_CLEARANCE = -0.4;
const FINGER_HEAD_CLEARANCE = 1.3;
const FINGER_STEM_CLEARANCE = 0.4;

/** How far right a note's dots sit beyond the normal gap: an up-stem flag curls down beside the head to about the height of the dot, so the dot moves clear of its tail. */
function dotShiftOf(p: PlacedPiece): number {
  return !p.isRest && !p.beamed && p.value.flags > 0 && p.stemUp ? FLAG_DOT_CLEARANCE : 0;
}

function ledgerPositions(position: number): number[] {
  const out: number[] = [];
  if (position <= -2) {
    for (let p = -2; p >= position; p -= 2) out.push(p);
  } else if (position >= 10) {
    for (let p = 10; p <= position; p += 2) out.push(p);
  }
  return out;
}

function emitDots(
  out: Primitives,
  p: PlacedPiece,
  rightEdge: number,
  y: number,
  noteIndex?: number,
): void {
  for (let k = 0; k < p.value.dots; k += 1) {
    out.glyph('augmentationDot', rightEdge + DOT_GAP + k * DOT_STEP, y, 'dot', noteIndex);
  }
}

function emitStem(out: Primitives, p: PlacedPiece, stemX: number, tipY: number): void {
  const startY = p.stemUp
    ? p.y + SMUFL_ANCHORS.noteheadBlack.stemUpSE[1]
    : p.y + SMUFL_ANCHORS.noteheadBlack.stemDownNW[1];
  out.line(stemX, startY, stemX, tipY, STEM_W, 'stem', (p.desc.item as AbcNoteElement).noteIndex);
}

function emitBeams(out: Primitives, members: readonly BeamMember[], line: BeamLine): void {
  const sign = line.up ? 1 : -1; // inward direction of the beam stack in y
  const polygonAt = (xl: number, xr: number, level: number): void => {
    const offset = sign * level * BEAM_STEP;
    const yl = beamY(line, xl) + offset;
    const yr = beamY(line, xr) + offset;
    const t = sign * BEAM_T;
    out.polygon(
      [
        [xl, yl],
        [xr, yr],
        [xr, yr + t],
        [xl, yl + t],
      ],
      'beam',
    );
  };

  const first = members[0]!;
  const last = members[members.length - 1]!;
  polygonAt(first.stemX - STEM_W / 2, last.stemX + STEM_W / 2, 0);

  const maxBeams = members.reduce((m, member) => Math.max(m, member.beams), 1);
  for (let level = 1; level < maxBeams; level += 1) {
    let i = 0;
    while (i < members.length) {
      if (members[i]!.beams <= level) {
        i += 1;
        continue;
      }
      let j = i;
      while (j + 1 < members.length && members[j + 1]!.beams > level) j += 1;
      if (j > i) {
        polygonAt(members[i]!.stemX - STEM_W / 2, members[j]!.stemX + STEM_W / 2, level);
      } else {
        // A lone note at this level gets a stub toward the note it shares its beat with.
        const m = members[i]!;
        const grid = 1 / 2 ** (level + 2);
        const startsPair =
          Math.abs((m.piece.desc.start / grid) % 1) < 1e-6 ||
          Math.abs(((m.piece.desc.start / grid) % 1) - 1) < 1e-6;
        const pointRight = i === 0 ? true : i === members.length - 1 ? false : startsPair;
        if (pointRight) polygonAt(m.stemX - STEM_W / 2, m.stemX - STEM_W / 2 + STUB_LENGTH, level);
        else polygonAt(m.stemX + STEM_W / 2 - STUB_LENGTH, m.stemX + STEM_W / 2, level);
      }
      i = j + 1;
    }
  }
}

function emitRest(out: Primitives, p: PlacedPiece, frame: BarFrame): void {
  const glyph = restGlyphOf(p.value);
  const width = STAFF_GLYPHS[glyph].width;
  const centered = frame.content.wholeBarRest;
  const x = centered ? frame.restCenterX - width / 2 : p.x + (HEAD_BLACK - width) / 2;
  // The whole rest hangs from the second line down; every other rest is placed from the middle line.
  const y = p.value.base >= 1 ? 1 : 2;
  out.glyph(glyph, x, y, 'rest');
  if (!centered) {
    for (let k = 0; k < p.value.dots; k += 1) {
      out.glyph('augmentationDot', x + width + DOT_GAP + k * DOT_STEP, 1.5, 'dot');
    }
  }
}

function emitTies(
  out: Primitives,
  frame: BarFrame,
  placedByKey: ReadonlyMap<string, PlacedPiece>,
  windowStartX: number,
  barStartX: number,
): void {
  for (const p of frame.pieces) {
    if (p.isRest) continue;
    const item = p.desc.item as AbcNoteElement;
    const side: 1 | -1 = p.stemUp ? 1 : -1;
    const y0 = p.y + side * TIE_SIDE_GAP;
    const rightOfHead =
      p.x + p.w + (p.value.dots > 0 ? dotsExtent(p.value.dots) + dotShiftOf(p) : 0) + 0.1;

    const hasNext = p.desc.indexInItem < p.desc.pieceCount - 1;
    if (hasNext) {
      const next = placedByKey.get(`${p.desc.itemIndex}:${p.desc.indexInItem + 1}`);
      if (next !== undefined) {
        out.path(tieCrescent(rightOfHead, next.x - 0.1, y0, side), 0, true, 'tie', item.noteIndex);
      } else {
        out.path(
          tieCrescent(rightOfHead, rightOfHead + TIE_STUB, y0, side),
          0,
          true,
          'tie',
          item.noteIndex,
        );
      }
    }
    if (
      p.desc.indexInItem > 0 &&
      !placedByKey.has(`${p.desc.itemIndex}:${p.desc.indexInItem - 1}`)
    ) {
      const end = p.x - 0.1;
      const start = Math.max(Math.min(barStartX, windowStartX) + 0.1, end - TIE_STUB);
      out.path(tieCrescent(start, end, y0, side), 0, true, 'tie', item.noteIndex);
    }
  }
}

// --- Tuplets -------------------------------------------------------------------------------

function emitTuplets(
  out: Primitives,
  index: ScoreIndex,
  frame: BarFrame,
  stemTip: ReadonlyMap<PlacedPiece, number>,
  stemXOf: (p: PlacedPiece) => number,
): void {
  const groups = new Map<number, PlacedPiece[]>();
  for (const p of frame.pieces) {
    const t = p.desc.item.tuplet;
    if (t === undefined) continue;
    const list = groups.get(t.id) ?? [];
    list.push(p);
    groups.set(t.id, list);
  }
  for (const members of groups.values()) {
    const tuplet = members[0]!.desc.item.tuplet!;
    const notes = members.filter((p) => !p.isRest);
    const up = notes.length === 0 ? true : notes.filter((p) => p.stemUp).length * 2 >= notes.length;

    // Beamed as one group: the number alone, over the beam.
    const groupIds = new Set(notes.map((p) => index.beamGroupOfItem[p.desc.itemIndex]!));
    const beamedAsOne =
      notes.length === members.length &&
      groupIds.size === 1 &&
      !groupIds.has(-1) &&
      new Set(notes.map((p) => p.desc.itemIndex)).size === tuplet.size;

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let edge = up
      ? Math.min(0, ...members.map((p) => (p.isRest ? 1 : p.y - 0.5)))
      : Math.max(4, ...members.map((p) => (p.isRest ? 3 : p.y + 0.5)));
    for (const p of members) {
      left = Math.min(left, p.x);
      right = Math.max(right, p.x + p.w);
      const tip = stemTip.get(p);
      if (tip !== undefined) {
        edge = up ? Math.min(edge, tip) : Math.max(edge, tip);
        const sx = stemXOf(p);
        left = Math.min(left, sx - STEM_W / 2);
        right = Math.max(right, sx + STEM_W / 2);
      }
    }
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;

    const digits = String(Math.max(0, Math.trunc(tuplet.actual))).split('');
    const glyphs = digits.map((d) => `tuplet${d}` as StaffGlyphName);
    const numberWidth = glyphs.reduce((w, g) => w + STAFF_GLYPHS[g].width, 0);
    const [, dTop, , dBottom] = STAFF_GLYPHS[glyphs[0]!].bounds;
    const digitHeight = dBottom - dTop;
    // A beamed number sits over the middle of the beam (first to last stem); a bracket's over the bracket.
    const stemXs = notes.filter((p) => stemTip.has(p)).map((p) => stemXOf(p));
    const centerX =
      beamedAsOne && stemXs.length > 0
        ? (Math.min(...stemXs) + Math.max(...stemXs)) / 2
        : (left + right) / 2;

    const drawNumber = (centerY: number): void => {
      // Digit glyphs sit on a baseline at the glyph origin; center the digit vertically on centerY.
      const baseline = centerY - (dTop + dBottom) / 2;
      let x = centerX - numberWidth / 2;
      for (const g of glyphs) {
        out.glyph(g, x, baseline, 'tuplet');
        x += STAFF_GLYPHS[g].width;
      }
    };

    if (beamedAsOne) {
      const clearance = 0.35;
      drawNumber(up ? edge - clearance - digitHeight / 2 : edge + clearance + digitHeight / 2);
    } else {
      const bracketY = up ? edge - 0.8 : edge + 0.8;
      const hook = up ? 0.6 : -0.6;
      const gap = numberWidth / 2 + 0.35;
      const t = E.tupletBracketThickness;
      const d =
        `M${f(left)} ${f(bracketY + hook)}L${f(left)} ${f(bracketY)}L${f(centerX - gap)} ${f(bracketY)}` +
        `M${f(centerX + gap)} ${f(bracketY)}L${f(right)} ${f(bracketY)}L${f(right)} ${f(bracketY + hook)}`;
      out.path(d, t, false, 'tuplet');
      drawNumber(bracketY);
    }
  }
}

// =================================================================================
// Bounds
// =================================================================================

/** [minX, minY, maxX, maxY] of a primitive, in staff spaces (strokes included; paths use their control points). */
export function primitiveBounds(p: ScorePrimitive): readonly [number, number, number, number] {
  switch (p.kind) {
    case 'line': {
      const dx = p.x2 - p.x1;
      const dy = p.y2 - p.y1;
      const length = Math.hypot(dx, dy);
      const nx = length > 0 ? (-dy / length) * (p.width / 2) : 0;
      const ny = length > 0 ? (dx / length) * (p.width / 2) : p.width / 2;
      const xs = [p.x1 + nx, p.x1 - nx, p.x2 + nx, p.x2 - nx];
      const ys = [p.y1 + ny, p.y1 - ny, p.y2 + ny, p.y2 - ny];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    case 'glyph': {
      const [x1, y1, x2, y2] = STAFF_GLYPHS[p.glyph].bounds;
      return [p.x + x1, p.y + y1, p.x + x2, p.y + y2];
    }
    case 'polygon': {
      const xs = p.points.map((pt) => pt[0]);
      const ys = p.points.map((pt) => pt[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    case 'path': {
      const numbers = (p.d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        xs.push(numbers[i]!);
        ys.push(numbers[i + 1]!);
      }
      const half = p.filled ? 0 : p.width / 2;
      if (xs.length === 0) return [0, 0, 0, 0];
      return [
        Math.min(...xs) - half,
        Math.min(...ys) - half,
        Math.max(...xs) + half,
        Math.max(...ys) + half,
      ];
    }
    case 'circle':
      return [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r];
  }
}

// =================================================================================
// Sizing
// =================================================================================

/**
 * Lays the score out to fill `availableWidthPx`, choosing the size of a staff
 * space so the notation is large without becoming taller than `maxHeightPx`.
 * Shared by both apps (each then draws the layout at `unitPx` per staff
 * space). If even the first bar needs more room than the width allows -- a
 * bar of sixteenths with accidentals on a narrow phone -- the whole score
 * shrinks to fit, down to about 6px per space, after which it overflows
 * (`layout.overflow`) rather than becoming unreadable.
 */
export function sizeScore(piece: AbcPiece, options: ScoreSizeOptions): ScoreSize {
  const minUnit = options.minUnitPx ?? 10;
  const maxUnit = options.maxUnitPx ?? 34;
  const available = Number.isFinite(options.availableWidthPx)
    ? Math.max(1, options.availableWidthPx)
    : 1;

  const layoutFor = (unit: number): ScoreLayout =>
    layoutScore(piece, {
      firstBar: options.firstBar,
      widthSpaces: available / unit,
      showTimeSignature: options.showTimeSignature,
      fingers: options.fingers,
    });

  let unit = Math.min(maxUnit, Math.max(minUnit, available / TARGET_SPACES_ACROSS));
  let layout = layoutFor(unit);
  // Shrinking changes how many bars fit (and so the height), so a few passes settle it.
  for (let pass = 0; pass < 6; pass += 1) {
    const height = layout.viewBox[3];
    let next = unit;
    if (layout.overflow)
      next = Math.min(next, Math.max(FLOOR_UNIT_PX, available / layout.widthSpaces));
    if (options.maxHeightPx !== undefined && height * next > options.maxHeightPx) {
      next = Math.min(next, Math.max(1, options.maxHeightPx / height));
    }
    if (Math.abs(next - unit) < 0.01) break;
    unit = next;
    layout = layoutFor(unit);
  }
  const [, , width, height] = layout.viewBox;
  return { layout, unitPx: unit, widthPx: width * unit, heightPx: height * unit };
}
