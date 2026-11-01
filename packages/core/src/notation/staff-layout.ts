/**
 * Geometry for drawing notes on a treble (G-clef) staff -- pure layout, no
 * rendering. Each platform draws the result with its own primitives (SVG
 * elements on desktop, react-native-svg on mobile), so the positions of lines,
 * ledger lines, noteheads, stems and accidentals are decided once, here, and
 * tested, instead of being re-derived per platform.
 *
 * ## Units and orientation
 *
 * Everything is in **staff spaces** (one unit = the gap between two adjacent
 * staff lines), x to the right, y *down*, with the top staff line at y = 0
 * and the bottom line at y = 4. This is also the unit of `staff-glyphs.ts`,
 * so glyph paths drop in at these coordinates with no scaling.
 *
 * A note's *staff position* counts half-spaces up from the bottom line:
 * 0 = bottom line (E4), 1 = the space above it (F4), 2 = second line (G4),
 * ... 8 = top line (F5); negative below the staff, > 8 above. Even positions
 * are lines, odd positions are spaces.
 *
 * ## What it shows
 *
 * A treble clef, then the notes left to right: the *target* first, then any
 * *upcoming* notes (ABC practice previews what follows). No key signature is
 * drawn: every sharp/flat/double accidental is written explicitly on its own
 * note, which is unambiguous for a one-note-at-a-time practice display. Notes
 * are drawn as filled quarter-note-style heads with stems (rhythm isn't
 * scored, so every note looks the same). Natural-letter notes carry no sign.
 */

import { NOTE_LETTERS, type NoteSpelling } from './note-spelling.js';
import { STAFF_GLYPHS, type StaffGlyphName } from './staff-glyphs.js';

export interface StaffNote {
  readonly spelling: NoteSpelling;
  /** `'target'` is the note to play now (drawn emphasized); `'upcoming'` are shown lighter. */
  readonly role: 'target' | 'upcoming';
}

export interface StaffLedgerLine {
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
}

export interface StaffNoteLayout {
  readonly role: StaffNote['role'];
  readonly spelling: NoteSpelling;
  /** Staff position (half-spaces above the bottom line). */
  readonly position: number;
  /** Left edge of the notehead glyph. */
  readonly x: number;
  /** Vertical center of the notehead. */
  readonly y: number;
  readonly stem: { readonly x: number; readonly y1: number; readonly y2: number };
  readonly ledgerLines: readonly StaffLedgerLine[];
  readonly accidental: { readonly glyph: StaffGlyphName; readonly x: number } | undefined;
}

export interface StaffLayout {
  /** [minX, minY, width, height] -- use directly as an SVG `viewBox`. */
  readonly viewBox: readonly [number, number, number, number];
  /** y of each of the five staff lines, top to bottom. */
  readonly lineYs: readonly number[];
  /** Horizontal extent of the five staff lines. */
  readonly lineX1: number;
  readonly lineX2: number;
  readonly clef: { readonly glyph: 'gClef'; readonly x: number; readonly y: number };
  readonly notes: readonly StaffNoteLayout[];
  readonly stemWidth: number;
  readonly lineWidth: number;
}

/** Diatonic index of the treble clef's bottom line (E4): octave 4, letter index 2. */
const BOTTOM_LINE_DIATONIC = 4 * 7 + 2;

const NOTEHEAD_WIDTH = STAFF_GLYPHS.noteheadBlack.width;

const STEM_LENGTH = 3.5;
const STEM_WIDTH = 0.12;
const LINE_WIDTH = 0.13;
const LEDGER_OVERHANG = 0.4;
const CLEF_X = 0.3;
const CLEF_G_LINE_Y = 3;
const FIRST_NOTE_GAP_AFTER_CLEF = 1.4;
const NOTE_SPACING = 3.1;
/** When the staff is wider than the notes need, they spread out -- but not further apart than this, so a short piece on a wide screen doesn't scatter. */
const MAX_NOTE_SPACING = 8;
const ACCIDENTAL_GAP = 0.25;
const RIGHT_MARGIN = 1.2;

/**
 * Vertical extent shown by default: room for the clef and for every note this
 * app can ask for (open G, G3, up to the detector's G6 ceiling, with its four
 * ledger lines above), so the staff keeps one height from note to note
 * instead of jumping as the target moves. Only a note beyond that range
 * extends it.
 */
const DEFAULT_MIN_Y = -5;
const DEFAULT_MAX_Y = 7.5;
const EXTENT_MARGIN = 0.8;

/** Staff position of a spelled note on the treble staff. */
export function staffPosition(spelling: NoteSpelling): number {
  const diatonic = spelling.octave * 7 + NOTE_LETTERS.indexOf(spelling.letter);
  return diatonic - BOTTOM_LINE_DIATONIC;
}

/** y (staff spaces, top line = 0) of a staff position. */
function positionY(position: number): number {
  return (8 - position) / 2;
}

function accidentalGlyph(accidental: number): StaffGlyphName | undefined {
  switch (accidental) {
    case 0:
      return undefined;
    case 1:
      return 'accidentalSharp';
    case -1:
      return 'accidentalFlat';
    case 2:
      return 'accidentalDoubleSharp';
    case -2:
      return 'accidentalDoubleFlat';
    default:
      // Spellings are limited to +-2 by construction; anything stranger is drawn with no sign rather than throwing from a render path.
      return undefined;
  }
}

/** Ledger lines needed between the staff and `position`, as staff positions (all even). */
function ledgerPositions(position: number): number[] {
  const out: number[] = [];
  if (position <= -2) {
    for (let p = -2; p >= position; p -= 2) out.push(p);
  } else if (position >= 10) {
    for (let p = 10; p <= position; p += 2) out.push(p);
  }
  return out;
}

export interface StaffLayoutOptions {
  /**
   * Make the staff at least this wide (in staff spaces). The staff lines run
   * the full width. By default (`align: 'spread'`) the notes also spread out
   * and are centered after the clef (a single note sits in the middle);
   * with `align: 'start'` they keep their natural spacing and stay
   * left-aligned after the clef, so the first note never moves. Narrower than
   * the notes need, it has no effect: the staff is never squeezed below its
   * natural width.
   */
  readonly minWidth?: number;
  readonly align?: 'spread' | 'start';
}

/** Lays the notes out with the given spacing, shifted right by `offsetX`. */
function build(notes: readonly StaffNote[], spacing: number, offsetX: number): StaffLayout {
  const clefEnd = CLEF_X + STAFF_GLYPHS.gClef.width;
  let cursorX = clefEnd + FIRST_NOTE_GAP_AFTER_CLEF + offsetX;

  let minY = DEFAULT_MIN_Y;
  let maxY = DEFAULT_MAX_Y;
  const laidOut: StaffNoteLayout[] = [];

  for (const note of notes) {
    const position = staffPosition(note.spelling);
    const y = positionY(position);
    const glyph = accidentalGlyph(note.spelling.accidental);

    // Room for the accidental sits to the left of the notehead.
    let noteX = cursorX;
    let accidental: StaffNoteLayout['accidental'];
    if (glyph) {
      accidental = { glyph, x: cursorX };
      noteX = cursorX + STAFF_GLYPHS[glyph].width + ACCIDENTAL_GAP;
    }

    // Stem direction: up for notes below the middle line, down from the middle line up (conventional).
    const stemUp = position < 4;
    const stemX = stemUp ? noteX + NOTEHEAD_WIDTH - STEM_WIDTH / 2 : noteX + STEM_WIDTH / 2;
    // A stem should always reach at least the middle line (y = 2), however far the head is from it.
    const stemEndY = stemUp ? Math.min(y - STEM_LENGTH, 2) : Math.max(y + STEM_LENGTH, 2);

    const ledgerLines = ledgerPositions(position).map((p) => ({
      x1: noteX - LEDGER_OVERHANG,
      x2: noteX + NOTEHEAD_WIDTH + LEDGER_OVERHANG,
      y: positionY(p),
    }));

    minY = Math.min(minY, y - EXTENT_MARGIN, stemEndY - EXTENT_MARGIN);
    maxY = Math.max(maxY, y + EXTENT_MARGIN, stemEndY + EXTENT_MARGIN);

    laidOut.push({
      role: note.role,
      spelling: note.spelling,
      position,
      x: noteX,
      y,
      stem: { x: stemX, y1: y, y2: stemEndY },
      ledgerLines,
      accidental,
    });

    cursorX = noteX + spacing;
  }

  const lastRight =
    laidOut.length > 0
      ? laidOut[laidOut.length - 1]!.x + NOTEHEAD_WIDTH
      : clefEnd + FIRST_NOTE_GAP_AFTER_CLEF;
  const width = lastRight + RIGHT_MARGIN;

  return {
    viewBox: [0, minY, width, maxY - minY],
    lineYs: [0, 1, 2, 3, 4],
    lineX1: 0,
    lineX2: width,
    clef: { glyph: 'gClef', x: CLEF_X, y: CLEF_G_LINE_Y },
    notes: laidOut,
    stemWidth: STEM_WIDTH,
    lineWidth: LINE_WIDTH,
  };
}

export function layoutStaff(
  notes: readonly StaffNote[],
  options: StaffLayoutOptions = {},
): StaffLayout {
  const natural = build(notes, NOTE_SPACING, 0);
  const naturalWidth = natural.viewBox[2];
  const minWidth = options.minWidth ?? 0;
  if (!(minWidth > naturalWidth)) return natural;

  if (options.align === 'start') {
    const [minX, minY, , height] = natural.viewBox;
    return { ...natural, viewBox: [minX, minY, minWidth, height], lineX2: minWidth };
  }

  // Wider than the notes need: spread them (up to a cap), then center the block after the clef.
  const spacing =
    notes.length > 1
      ? Math.min(MAX_NOTE_SPACING, NOTE_SPACING + (minWidth - naturalWidth) / (notes.length - 1))
      : NOTE_SPACING;
  const spread = build(notes, spacing, 0);
  const offsetX = Math.max(0, (minWidth - spread.viewBox[2]) / 2);
  const centered = build(notes, spacing, offsetX);

  const [minX, minY, , height] = centered.viewBox;
  return {
    ...centered,
    viewBox: [minX, minY, minWidth, height],
    lineX2: minWidth,
  };
}

export interface StaffSizeOptions {
  /**
   * Limits on the *preferred* size of one staff space, in px (defaults 8 and
   * 40): the size is aimed at the width but clamped into this range. The
   * minimum is not a hard floor -- if the notes cannot fit the width even at
   * that size, the staff shrinks below it rather than overflowing.
   */
  readonly minUnitPx?: number;
  readonly maxUnitPx?: number;
  /** Never make the staff taller than this (px). */
  readonly maxHeightPx?: number;
  /**
   * Treat every note after the first as a lookahead preview: show as many of
   * them as fit across the width at their natural spacing (never fewer than
   * the first note, which is the target), left-aligned so the target stays
   * put as the piece advances. Without it, every note given is drawn and the
   * staff spreads or shrinks to hold them.
   */
  readonly lookahead?: boolean;
}

export interface StaffSize {
  /** The layout of the notes actually drawn (`layout.notes.length` of the notes given, fewer when `lookahead` trims to fit). */
  readonly layout: StaffLayout;
  /** px per staff space. */
  readonly unitPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** About how many staff spaces wide the staff aims to be, before the size limits apply: sets how big the notation is relative to the screen. */
const TARGET_SPACES_ACROSS = 30;

/**
 * Lays the staff out to fill `availableWidthPx` edge to edge, choosing the
 * size of a staff space so the notation is large without becoming taller than
 * `maxHeightPx`. Shared by both apps (each then draws the layout at
 * `unitPx` per staff space). If the notes need more room than that width
 * allows -- five notes with accidentals on a narrow phone -- the whole staff
 * shrinks to fit rather than overflowing.
 */
export function sizeStaff(
  notes: readonly StaffNote[],
  availableWidthPx: number,
  options: StaffSizeOptions = {},
): StaffSize {
  const minUnit = options.minUnitPx ?? 8;
  const maxUnit = options.maxUnitPx ?? 40;
  const lookahead = options.lookahead === true;
  const available = Math.max(1, availableWidthPx);

  const layoutFor = (unit: number): StaffLayout => {
    const spaces = available / unit;
    if (!lookahead) return layoutStaff(notes, { minWidth: spaces });
    // The longest run of notes (target first, always at least it) that fits at natural spacing.
    let shown = Math.min(notes.length, 1);
    while (shown < notes.length && layoutStaff(notes.slice(0, shown + 1)).viewBox[2] <= spaces) {
      shown += 1;
    }
    return layoutStaff(notes.slice(0, shown), { minWidth: spaces, align: 'start' });
  };

  let unit = Math.min(maxUnit, Math.max(minUnit, available / TARGET_SPACES_ACROSS));
  let layout = layoutFor(unit);
  // Shrinking changes how many spaces fit across, which can change the layout; a few passes settle it.
  for (let pass = 0; pass < 4; pass += 1) {
    const [, , width, height] = layout.viewBox;
    let next = unit;
    if (width * unit > available + 0.5) next = available / width;
    if (options.maxHeightPx !== undefined && height * next > options.maxHeightPx) {
      next = Math.min(next, options.maxHeightPx / height);
    }
    if (Math.abs(next - unit) < 0.01) break;
    unit = next;
    layout = layoutFor(unit);
  }
  const [, , width, height] = layout.viewBox;
  return { layout, unitPx: unit, widthPx: width * unit, heightPx: height * unit };
}
