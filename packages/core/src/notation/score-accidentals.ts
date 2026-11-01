/**
 * Which accidental signs a printed score draws, and how a key signature is
 * written -- the two halves of the same convention.
 *
 * ABC (and `NoteSpelling`) give every note its *real* offset from the natural
 * letter: an F-sharp in G major is `{ F, +1 }` whether or not the sheet prints
 * a sign in front of it. A printed score does not draw that sign when the key
 * signature already says so, and draws one only when a note departs from what
 * is currently in force. Getting that wrong is not cosmetic: a sharp sign on
 * every F in G major looks like a different piece, and a missing natural sign
 * silently changes the pitch the player reads. So the rules live here, apart
 * from layout, and are pinned by tests.
 *
 * ## The rules
 *
 * - The **key signature** in force sets a default offset for each letter, in
 *   every octave (F-sharp in G major means every F).
 * - An **accidental sign** on a note holds for the rest of its **bar**, but only
 *   for that exact pitch -- the same letter *and* octave (a sharp on F4 does not
 *   reach F5). The next bar line cancels it and the key signature is back in
 *   force.
 * - A note draws a sign exactly when its real offset differs from the offset
 *   currently in effect for its letter and octave; the sign is a natural when
 *   that real offset is 0. Equal offsets draw nothing.
 * - **No courtesy accidentals** (the optional reminder sign in the bar after an
 *   accidental): the display is for reading pitch, and a reminder that is not
 *   there is never wrong.
 * - A key signature can only print single sharps/flats. A key whose letters
 *   carry a larger offset (a theoretical double-sharp key, or an `exp` key) has
 *   those letters treated as natural in the *printed* signature, so notes on
 *   them draw explicit signs: what is printed is always what the rules above
 *   are applied against.
 *
 * Pure TypeScript; no platform imports.
 */

import { NO_KEY_OFFSETS, type AbcPiece, type KeyOffsets } from '../abc/abc-score.js';
import { staffSpellingOf } from '../sequence/sequence-generator.js';
import type { NoteLetter } from './note-spelling.js';
import type { StaffGlyphName } from './staff-glyphs.js';

// --- Key signatures --------------------------------------------------------------------

/** Letters in the order sharps are added to a key signature (F# first). */
const SHARP_ORDER: readonly NoteLetter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
/** Letters in the order flats are added (B-flat first) -- the sharp order reversed. */
const FLAT_ORDER: readonly NoteLetter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/**
 * Staff position (half-spaces above the bottom line, as `staffPosition` counts
 * them) of each signature accidental in the treble clef. These are the
 * engraver's fixed patterns: sharps keep inside the staff (F5 on the top line,
 * C5, G5 above it, D5, A4, E5, B4) and flats zig-zag the same way (B4, E5, A4,
 * D5, G4, C5, F4); neither follows the plain octave of the letter.
 */
const SHARP_POSITIONS: Readonly<Record<NoteLetter, number>> = {
  F: 8,
  C: 5,
  G: 9,
  D: 6,
  A: 3,
  E: 7,
  B: 4,
};
const FLAT_POSITIONS: Readonly<Record<NoteLetter, number>> = {
  B: 4,
  E: 7,
  A: 3,
  D: 6,
  G: 2,
  C: 5,
  F: 1,
};

/** One sign of a key signature. */
export interface KeySignatureAccidental {
  readonly glyph: Extract<
    StaffGlyphName,
    'accidentalSharp' | 'accidentalFlat' | 'accidentalNatural'
  >;
  readonly letter: NoteLetter;
  /** Staff position in half-spaces above the bottom line (E4 = 0). */
  readonly position: number;
}

/**
 * The offsets a key signature can actually *print*: single sharps and flats.
 * Anything larger (a double-sharp letter in a theoretical key) is shown as
 * natural, so notes on that letter carry their own sign.
 */
export function displayedKeyOffsets(offsets: KeyOffsets): KeyOffsets {
  const out = { ...NO_KEY_OFFSETS } as Record<NoteLetter, number>;
  for (const letter of SHARP_ORDER) {
    const value = offsets[letter];
    out[letter] = value === 1 || value === -1 ? value : 0;
  }
  return out;
}

/**
 * The signs to print for a key signature, left to right: sharps in the order
 * F C G D A E B, then flats in the order B E A D G C F (a real key has only one
 * kind; an `exp` key mixing both prints sharps first), each at its standard
 * treble-clef position. A letter whose offset is not a single sharp or flat is
 * left out (see `displayedKeyOffsets`).
 *
 * With `previous`, the signature is a *change*: the naturals that cancel the
 * old signature's signs come first (every letter that was sharp or flat before
 * and is not the same now, at the position the old sign had), then the new
 * signs -- how a key change is engraved, so the reader is never left to infer
 * that a change to C major happened from nothing being drawn.
 */
export function keySignatureGlyphs(
  offsets: KeyOffsets,
  previous?: KeyOffsets,
): readonly KeySignatureAccidental[] {
  const now = displayedKeyOffsets(offsets);
  const out: KeySignatureAccidental[] = [];

  if (previous !== undefined) {
    const before = displayedKeyOffsets(previous);
    for (const letter of SHARP_ORDER) {
      if (before[letter] === 1 && now[letter] !== 1) {
        out.push({ glyph: 'accidentalNatural', letter, position: SHARP_POSITIONS[letter] });
      }
    }
    for (const letter of FLAT_ORDER) {
      if (before[letter] === -1 && now[letter] !== -1) {
        out.push({ glyph: 'accidentalNatural', letter, position: FLAT_POSITIONS[letter] });
      }
    }
  }
  for (const letter of SHARP_ORDER) {
    if (now[letter] === 1) {
      out.push({ glyph: 'accidentalSharp', letter, position: SHARP_POSITIONS[letter] });
    }
  }
  for (const letter of FLAT_ORDER) {
    if (now[letter] === -1) {
      out.push({ glyph: 'accidentalFlat', letter, position: FLAT_POSITIONS[letter] });
    }
  }
  return out;
}

// --- Accidentals on notes ---------------------------------------------------------------

export interface DisplayAccidentalOptions {
  /**
   * Compute as if no key signature were ever printed (every sharp, flat and
   * natural departing from plain C major then gets its own sign). For a
   * display that deliberately leaves the signature out.
   */
  readonly ignoreKeySignature?: boolean;
}

const cache = new WeakMap<AbcPiece, ReadonlyMap<number, number>>();

/**
 * The accidental sign to draw in front of each note, by practice-note index:
 * -2..2, where 0 means a **natural sign** (a note absent from the map draws
 * nothing). See the module comment for the rules; in short, a note gets a sign
 * only when its real offset differs from what the key signature and the earlier
 * accidentals of its bar already say for that letter and octave.
 *
 * A tie merges into one `note` element in the piece, so a tied note has one
 * entry (on its first notehead): the continuation heads never carry signs.
 *
 * The result for a piece is cached (pieces are immutable), so layout can ask
 * for it every time a window is drawn.
 */
export function computeDisplayAccidentals(
  piece: AbcPiece,
  options: DisplayAccidentalOptions = {},
): ReadonlyMap<number, number> {
  const useCache = options.ignoreKeySignature !== true;
  if (useCache) {
    const cached = cache.get(piece);
    if (cached !== undefined) return cached;
  }

  const ignoreKey = options.ignoreKeySignature === true;
  let key: KeyOffsets = ignoreKey ? NO_KEY_OFFSETS : displayedKeyOffsets(piece.keyAtStart);
  /** Offset in force for a pitch (letter + octave) because of an earlier accidental in this bar. */
  const inBar = new Map<string, number>();
  let currentBar = Number.NaN;
  const out = new Map<number, number>();

  const enterBar = (bar: number): void => {
    if (bar !== currentBar) {
      inBar.clear();
      currentBar = bar;
    }
  };

  for (const element of piece.elements) {
    switch (element.type) {
      case 'key':
        if (!ignoreKey) key = displayedKeyOffsets(element.offsets);
        // A new signature starts afresh: the old bar's accidentals are not carried into it.
        inBar.clear();
        break;
      case 'bar':
        inBar.clear();
        break;
      case 'rest':
        enterBar(element.bar);
        break;
      case 'note': {
        enterBar(element.bar);
        const note = piece.notes[element.noteIndex];
        if (note === undefined) break;
        const spelling = staffSpellingOf(note);
        const pitch = `${spelling.letter}${spelling.octave}`;
        const inForce = inBar.get(pitch) ?? key[spelling.letter];
        if (spelling.accidental !== inForce) {
          out.set(element.noteIndex, spelling.accidental);
          inBar.set(pitch, spelling.accidental);
        }
        break;
      }
      case 'meter':
      case 'tempo':
        break;
    }
  }

  if (useCache) cache.set(piece, out);
  return out;
}
