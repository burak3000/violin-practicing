import { describe, expect, it } from 'vitest';
import { spellMidi, type NoteSpelling } from './note-spelling.js';
import { STAFF_GLYPHS } from './staff-glyphs.js';
import { layoutStaff, sizeStaff, staffPosition } from './staff-layout.js';

const sp = (letter: NoteSpelling['letter'], accidental: number, octave: number): NoteSpelling => ({
  letter,
  accidental,
  octave,
});
const target = (spelling: NoteSpelling) => ({ spelling, role: 'target' as const });
const upcoming = (spelling: NoteSpelling) => ({ spelling, role: 'upcoming' as const });

describe('staffPosition: half-spaces above the bottom line (E4) of the treble staff', () => {
  it('puts the five lines at even positions 0..8 (E4 G4 B4 D5 F5)', () => {
    expect(staffPosition(sp('E', 0, 4))).toBe(0);
    expect(staffPosition(sp('G', 0, 4))).toBe(2);
    expect(staffPosition(sp('B', 0, 4))).toBe(4);
    expect(staffPosition(sp('D', 0, 5))).toBe(6);
    expect(staffPosition(sp('F', 0, 5))).toBe(8);
  });

  it('puts the spaces at odd positions (F4 A4 C5 E5)', () => {
    expect(staffPosition(sp('F', 0, 4))).toBe(1);
    expect(staffPosition(sp('A', 0, 4))).toBe(3);
    expect(staffPosition(sp('C', 0, 5))).toBe(5);
    expect(staffPosition(sp('E', 0, 5))).toBe(7);
  });

  it('puts middle C one ledger line below, and the violin open strings where they belong', () => {
    expect(staffPosition(sp('C', 0, 4))).toBe(-2);
    expect(staffPosition(sp('G', 0, 3))).toBe(-5); // open G
    expect(staffPosition(sp('D', 0, 4))).toBe(-1); // open D, the space below the staff
    expect(staffPosition(sp('A', 0, 4))).toBe(3); // open A
    expect(staffPosition(sp('E', 0, 5))).toBe(7); // open E
  });

  it('ignores the accidental: F#4 and Fb4 sit on the F4 space', () => {
    expect(staffPosition(sp('F', 1, 4))).toBe(1);
    expect(staffPosition(sp('F', -1, 4))).toBe(1);
  });

  it('puts B-flat on the B line, not the A space (spelling matters)', () => {
    expect(staffPosition(sp('B', -1, 4))).toBe(4);
    expect(staffPosition(sp('A', 1, 4))).toBe(3);
  });
});

describe('layoutStaff: the staff itself', () => {
  const layout = layoutStaff([target(sp('E', 0, 4))]);

  it('has five lines, top at y=0 and bottom at y=4, spanning the whole width', () => {
    expect(layout.lineYs).toEqual([0, 1, 2, 3, 4]);
    expect(layout.lineX1).toBe(0);
    expect(layout.lineX2).toBe(layout.viewBox[2]);
  });

  it('places the G clef on the second line from the bottom (the G line, y=3)', () => {
    expect(layout.clef).toMatchObject({ glyph: 'gClef', y: 3 });
  });

  it('has a default vertical extent with room for the clef and ledger lines', () => {
    const [minX, minY, width, height] = layout.viewBox;
    expect(minX).toBe(0);
    expect(minY).toBeLessThanOrEqual(-3);
    expect(minY + height).toBeGreaterThanOrEqual(7);
    expect(width).toBeGreaterThan(layout.clef.x + STAFF_GLYPHS.gClef.width);
  });

  it('draws only the staff and clef for an empty list of notes', () => {
    const empty = layoutStaff([]);
    expect(empty.notes).toEqual([]);
    expect(empty.viewBox[2]).toBeGreaterThan(0);
  });
});

describe('layoutStaff: note placement', () => {
  it('centers each head on its position (E4 on the bottom line y=4, F5 on the top line y=0)', () => {
    const [low, high] = layoutStaff([target(sp('E', 0, 4)), upcoming(sp('F', 0, 5))]).notes;
    expect(low!.y).toBe(4);
    expect(high!.y).toBe(0);
  });

  it('passes the role through and lays notes out left to right in the order given', () => {
    const notes = layoutStaff([
      target(sp('G', 0, 4)),
      upcoming(sp('A', 0, 4)),
      upcoming(sp('B', 0, 4)),
    ]).notes;
    expect(notes.map((n) => n.role)).toEqual(['target', 'upcoming', 'upcoming']);
    expect(notes[0]!.x).toBeLessThan(notes[1]!.x);
    expect(notes[1]!.x).toBeLessThan(notes[2]!.x);
  });

  it('starts the first note clear of the clef', () => {
    const layout = layoutStaff([target(sp('G', 0, 4))]);
    expect(layout.notes[0]!.x).toBeGreaterThan(layout.clef.x + STAFF_GLYPHS.gClef.width);
  });

  it('grows the viewBox width to fit every note', () => {
    const one = layoutStaff([target(sp('G', 0, 4))]);
    const five = layoutStaff([
      target(sp('G', 0, 4)),
      upcoming(sp('A', 0, 4)),
      upcoming(sp('B', 0, 4)),
      upcoming(sp('C', 0, 5)),
      upcoming(sp('D', 0, 5)),
    ]);
    expect(five.viewBox[2]).toBeGreaterThan(one.viewBox[2]);
    const last = five.notes[4]!;
    expect(five.viewBox[2]).toBeGreaterThan(last.x + STAFF_GLYPHS.noteheadBlack.width);
  });
});

describe('layoutStaff: ledger lines', () => {
  const ledgerYs = (spelling: NoteSpelling) =>
    layoutStaff([target(spelling)]).notes[0]!.ledgerLines.map((l) => l.y);

  it('needs none for notes on or inside the staff, or in the spaces just outside it', () => {
    for (const s of [sp('E', 0, 4), sp('F', 0, 5), sp('C', 0, 5), sp('D', 0, 4), sp('G', 0, 5)]) {
      expect(ledgerYs(s)).toEqual([]);
    }
  });

  it('draws one for middle C (below) and one for A5 (above)', () => {
    expect(ledgerYs(sp('C', 0, 4))).toEqual([5]);
    expect(ledgerYs(sp('A', 0, 5))).toEqual([-1]);
  });

  it('draws every line between the staff and the note, for a space note too', () => {
    expect(ledgerYs(sp('A', 0, 3))).toEqual([5, 6]); // A3: second ledger line below
    expect(ledgerYs(sp('G', 0, 3))).toEqual([5, 6]); // open G: the space under it
    expect(ledgerYs(sp('C', 0, 6))).toEqual([-1, -2]); // C6: second ledger line above
  });

  it('draws each ledger line wider than the notehead on both sides', () => {
    const note = layoutStaff([target(sp('C', 0, 4))]).notes[0]!;
    const line = note.ledgerLines[0]!;
    expect(line.x1).toBeLessThan(note.x);
    expect(line.x2).toBeGreaterThan(note.x + STAFF_GLYPHS.noteheadBlack.width);
  });
});

describe('layoutStaff: stems', () => {
  const stemOf = (spelling: NoteSpelling) => layoutStaff([target(spelling)]).notes[0]!;

  it('points up below the middle line, on the right edge of the head', () => {
    const note = stemOf(sp('E', 0, 4));
    expect(note.stem.y2).toBeLessThan(note.stem.y1);
    expect(note.stem.x).toBeGreaterThan(note.x + STAFF_GLYPHS.noteheadBlack.width / 2);
  });

  it('points down from the middle line up, on the left edge of the head', () => {
    const note = stemOf(sp('B', 0, 4));
    expect(note.stem.y2).toBeGreaterThan(note.stem.y1);
    expect(note.stem.x).toBeLessThan(note.x + STAFF_GLYPHS.noteheadBlack.width / 2);
  });

  it('is about three and a half spaces long for a note near the staff', () => {
    const note = stemOf(sp('E', 0, 4));
    expect(note.stem.y1 - note.stem.y2).toBeCloseTo(3.5, 5);
  });

  it('is always long enough to reach the middle line, however far away the head is', () => {
    const high = stemOf(sp('C', 0, 6)); // stem down from far above
    expect(high.stem.y2).toBeGreaterThanOrEqual(2);
    const low = stemOf(sp('G', 0, 3)); // stem up from far below
    expect(low.stem.y2).toBeLessThanOrEqual(2);
  });
});

describe('layoutStaff: accidentals', () => {
  const noteWith = (accidental: number) => layoutStaff([target(sp('F', accidental, 4))]).notes[0]!;

  it('draws no sign for a natural', () => {
    expect(noteWith(0).accidental).toBeUndefined();
  });

  it('chooses the right glyph for sharp, flat, double sharp and double flat', () => {
    expect(noteWith(1).accidental?.glyph).toBe('accidentalSharp');
    expect(noteWith(-1).accidental?.glyph).toBe('accidentalFlat');
    expect(noteWith(2).accidental?.glyph).toBe('accidentalDoubleSharp');
    expect(noteWith(-2).accidental?.glyph).toBe('accidentalDoubleFlat');
  });

  it('places the sign to the left of the head without overlapping it', () => {
    const note = noteWith(1);
    const glyph = STAFF_GLYPHS.accidentalSharp;
    expect(note.accidental!.x + glyph.width).toBeLessThan(note.x);
  });

  it('pushes the head right to make room, and still starts clear of the clef', () => {
    const plain = layoutStaff([target(sp('F', 0, 4))]).notes[0]!;
    const sharp = noteWith(1);
    expect(sharp.x).toBeGreaterThan(plain.x);
    expect(sharp.accidental!.x).toBeGreaterThan(STAFF_GLYPHS.gClef.width);
  });

  it('keeps successive notes apart when one carries an accidental', () => {
    const [a, b] = layoutStaff([target(sp('F', 1, 4)), upcoming(sp('G', 0, 4))]).notes;
    expect(b!.x - (a!.x + STAFF_GLYPHS.noteheadBlack.width)).toBeGreaterThan(1);
  });
});

describe('layoutStaff: extents grow for extreme notes', () => {
  it('keeps one height for every note from the open G string up to the G6 detector ceiling, so the staff never jumps', () => {
    const baseline = layoutStaff([]).viewBox;
    for (let midi = 55; midi <= 91; midi += 1) {
      const notes = layoutStaff([target(spellMidi(midi)), upcoming(spellMidi(midi))]);
      expect(notes.viewBox[1]).toBe(baseline[1]);
      expect(notes.viewBox[3]).toBe(baseline[3]);
    }
  });

  it('extends upward so a very high note (C8) is not clipped', () => {
    const base = layoutStaff([target(sp('E', 0, 4))]);
    const high = layoutStaff([target(sp('C', 0, 8))]);
    const note = high.notes[0]!;
    expect(high.viewBox[1]).toBeLessThan(base.viewBox[1]);
    expect(high.viewBox[1]).toBeLessThan(note.y);
  });

  it('extends downward so a very low note is not clipped', () => {
    const low = layoutStaff([target(sp('C', 0, 1))]);
    expect(low.viewBox[1] + low.viewBox[3]).toBeGreaterThan(low.notes[0]!.y);
  });
});

describe('STAFF_GLYPHS', () => {
  it('has a non-empty outline and positive width for every glyph', () => {
    for (const glyph of Object.values(STAFF_GLYPHS)) {
      expect(glyph.path.startsWith('M')).toBe(true);
      expect(glyph.path.length).toBeGreaterThan(50);
      expect(glyph.width).toBeGreaterThan(0);
    }
  });

  it('is in staff-space units: the clef is about seven spaces tall and the notehead about one wide', () => {
    const [, minY, , maxY] = STAFF_GLYPHS.gClef.bounds;
    expect(maxY - minY).toBeGreaterThan(6);
    expect(maxY - minY).toBeLessThan(8);
    expect(STAFF_GLYPHS.noteheadBlack.width).toBeGreaterThan(1);
    expect(STAFF_GLYPHS.noteheadBlack.width).toBeLessThan(1.5);
  });
});

describe('layoutStaff: minWidth (filling a wide screen)', () => {
  const five = [
    target(sp('G', 0, 4)),
    upcoming(sp('A', 0, 4)),
    upcoming(sp('B', 0, 4)),
    upcoming(sp('C', 0, 5)),
    upcoming(sp('D', 0, 5)),
  ];

  it('has no effect when the notes already need more room than that', () => {
    const natural = layoutStaff(five);
    expect(layoutStaff(five, { minWidth: 5 })).toEqual(natural);
    expect(layoutStaff(five, { minWidth: natural.viewBox[2] })).toEqual(natural);
  });

  it('makes the viewBox and the staff lines exactly that wide', () => {
    const wide = layoutStaff(five, { minWidth: 60 });
    expect(wide.viewBox[2]).toBe(60);
    expect(wide.lineX1).toBe(0);
    expect(wide.lineX2).toBe(60);
  });

  it('keeps the height, clef and note order unchanged', () => {
    const natural = layoutStaff(five);
    const wide = layoutStaff(five, { minWidth: 60 });
    expect(wide.viewBox[1]).toBe(natural.viewBox[1]);
    expect(wide.viewBox[3]).toBe(natural.viewBox[3]);
    expect(wide.clef).toEqual(natural.clef);
    expect(wide.notes.map((n) => n.spelling)).toEqual(natural.notes.map((n) => n.spelling));
    for (let i = 1; i < wide.notes.length; i += 1) {
      expect(wide.notes[i]!.x).toBeGreaterThan(wide.notes[i - 1]!.x);
    }
  });

  it('spreads the notes further apart, within the staff, clear of the clef', () => {
    const natural = layoutStaff(five);
    const wide = layoutStaff(five, { minWidth: 40 });
    const gap = (l: typeof natural) => l.notes[1]!.x - l.notes[0]!.x;
    expect(gap(wide)).toBeGreaterThan(gap(natural));
    expect(wide.notes[0]!.x).toBeGreaterThan(STAFF_GLYPHS.gClef.width);
    const last = wide.notes[4]!;
    expect(last.x + STAFF_GLYPHS.noteheadBlack.width).toBeLessThan(40);
  });

  it('does not scatter a few notes across a huge width: spacing is capped, and the group is centered', () => {
    const huge = layoutStaff(five, { minWidth: 400 });
    const gap = huge.notes[1]!.x - huge.notes[0]!.x;
    expect(gap).toBeLessThanOrEqual(8 + 1e-9);
    const left = huge.notes[0]!.x - STAFF_GLYPHS.gClef.width;
    const right = 400 - (huge.notes[4]!.x + STAFF_GLYPHS.noteheadBlack.width);
    expect(left).toBeGreaterThan(50); // pushed well away from the clef...
    expect(Math.abs(left - right)).toBeLessThan(3); // ...and balanced either side
  });

  it('puts a lone note in the middle of the space after the clef', () => {
    const wide = layoutStaff([target(sp('E', 0, 4))], { minWidth: 40 });
    const note = wide.notes[0]!;
    const centerOfFree = (STAFF_GLYPHS.gClef.width + 40) / 2;
    expect(Math.abs(note.x + STAFF_GLYPHS.noteheadBlack.width / 2 - centerOfFree)).toBeLessThan(2);
  });

  it("keeps each note's own geometry (stem, ledger lines, accidental) attached to its head", () => {
    const [n] = layoutStaff([target(sp('C', 1, 4))], { minWidth: 50 }).notes;
    expect(n!.accidental!.x + STAFF_GLYPHS.accidentalSharp.width).toBeLessThan(n!.x);
    expect(n!.ledgerLines[0]!.x1).toBeLessThan(n!.x);
    expect(n!.stem.x).toBeGreaterThan(n!.x);
    expect(n!.stem.x).toBeLessThan(n!.x + STAFF_GLYPHS.noteheadBlack.width);
  });

  it('still draws just the staff and clef across the full width for no notes', () => {
    const empty = layoutStaff([], { minWidth: 30 });
    expect(empty.viewBox[2]).toBe(30);
    expect(empty.notes).toEqual([]);
  });
});

describe('sizeStaff: fit the staff to a pixel width', () => {
  const one = [target(sp('G', 0, 4))];
  const five = [
    target(sp('G', 1, 4)),
    upcoming(sp('A', 1, 4)),
    upcoming(sp('B', -1, 4)),
    upcoming(sp('C', 1, 5)),
    upcoming(sp('D', -1, 5)),
  ];

  it('fills the available width exactly when there is room', () => {
    const size = sizeStaff(one, 1000);
    expect(size.widthPx).toBeCloseTo(1000, 3);
    expect(size.layout.viewBox[2] * size.unitPx).toBeCloseTo(1000, 3);
  });

  it('makes the notation bigger on a bigger screen (up to a limit), never smaller than the minimum', () => {
    const small = sizeStaff(one, 360);
    const large = sizeStaff(one, 1400);
    expect(large.unitPx).toBeGreaterThan(small.unitPx);
    expect(sizeStaff(one, 4000).unitPx).toBeLessThanOrEqual(40);
    // A narrow width would suggest a smaller unit than the minimum; when the notes still fit, the minimum is used.
    expect(sizeStaff(one, 200, { minUnitPx: 8 }).unitPx).toBeCloseTo(8, 6);
  });

  it('shrinks the whole staff to fit rather than overflowing when the notes need more room', () => {
    // Five notes with accidentals need ~28 staff spaces; 200px cannot hold that at the minimum size... so it shrinks below it.
    const size = sizeStaff(five, 200);
    expect(size.widthPx).toBeLessThanOrEqual(200 + 0.5);
    expect(size.unitPx).toBeLessThan(8);
  });

  it('never exceeds a maximum height, widening the staff in staff spaces instead', () => {
    const uncapped = sizeStaff(one, 1200);
    const capped = sizeStaff(one, 1200, { maxHeightPx: 150 });
    expect(uncapped.heightPx).toBeGreaterThan(150);
    expect(capped.heightPx).toBeLessThanOrEqual(150 + 0.5);
    expect(capped.widthPx).toBeCloseTo(1200, 3);
    expect(capped.layout.viewBox[2]).toBeGreaterThan(uncapped.layout.viewBox[2]);
  });

  it('reports a height consistent with its own layout and unit', () => {
    const size = sizeStaff(five, 700);
    expect(size.heightPx).toBeCloseTo(size.layout.viewBox[3] * size.unitPx, 6);
  });

  it('copes with a zero or negative width without throwing', () => {
    expect(() => sizeStaff(one, 0)).not.toThrow();
    expect(() => sizeStaff(one, -50)).not.toThrow();
  });
});

describe("layoutStaff: align 'start' (keeps the first note in place)", () => {
  const three = [target(sp('G', 0, 4)), upcoming(sp('A', 0, 4)), upcoming(sp('B', 0, 4))];

  it('keeps natural spacing and the first note exactly where it is, but still runs the lines the full width', () => {
    const natural = layoutStaff(three);
    const wide = layoutStaff(three, { minWidth: 80, align: 'start' });
    expect(wide.notes.map((n) => n.x)).toEqual(natural.notes.map((n) => n.x));
    expect(wide.viewBox[2]).toBe(80);
    expect(wide.lineX2).toBe(80);
  });

  it('differs from the default, which spreads and centers the notes', () => {
    const spread = layoutStaff(three, { minWidth: 80 });
    const start = layoutStaff(three, { minWidth: 80, align: 'start' });
    expect(spread.notes[0]!.x).toBeGreaterThan(start.notes[0]!.x);
  });

  it('is also a no-op when the notes need more room than that', () => {
    const natural = layoutStaff(three);
    expect(layoutStaff(three, { minWidth: 3, align: 'start' })).toEqual(natural);
  });
});

describe('sizeStaff: lookahead (as many upcoming notes as fit)', () => {
  /** A rising run of notes, target first (E4 up through a few octaves of naturals). */
  const run = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      i === 0 ? target(spellMidi(60)) : upcoming(spellMidi(60 + (i % 20))),
    );
  const many = run(60);

  it('shows many more upcoming notes than the old fixed four, filling the width', () => {
    const size = sizeStaff(many, 1000, { lookahead: true, maxHeightPx: 320 });
    expect(size.layout.notes.length).toBeGreaterThan(8);
    expect(size.layout.notes.length).toBeLessThan(many.length);
    expect(size.widthPx).toBeCloseTo(1000, 3);
  });

  it('never draws a note outside the staff', () => {
    const size = sizeStaff(many, 1000, { lookahead: true, maxHeightPx: 320 });
    const last = size.layout.notes[size.layout.notes.length - 1]!;
    expect(last.x + STAFF_GLYPHS.noteheadBlack.width).toBeLessThanOrEqual(size.layout.viewBox[2]);
  });

  it('is full: one more note would not have fitted', () => {
    const size = sizeStaff(many, 1000, { lookahead: true, maxHeightPx: 320 });
    const shown = size.layout.notes.length;
    const spaces = 1000 / size.unitPx;
    expect(layoutStaff(many.slice(0, shown + 1)).viewBox[2]).toBeGreaterThan(spaces);
  });

  it('shows more notes in a wider window and fewer in a narrower one', () => {
    const narrow = sizeStaff(many, 390, { lookahead: true, maxHeightPx: 240 });
    const wide = sizeStaff(many, 1500, { lookahead: true, maxHeightPx: 320 });
    expect(wide.layout.notes.length).toBeGreaterThan(narrow.layout.notes.length);
    expect(narrow.layout.notes.length).toBeGreaterThan(4); // even a phone beats the old four
  });

  it('always shows the target first, even where nothing else fits', () => {
    const size = sizeStaff(many, 60, { lookahead: true });
    expect(size.layout.notes.length).toBe(1);
    expect(size.layout.notes[0]!.role).toBe('target');
    expect(size.widthPx).toBeLessThanOrEqual(60 + 0.5);
  });

  it('shows every note when the piece is nearly over, left-aligned', () => {
    const tail = run(3);
    const size = sizeStaff(tail, 1000, { lookahead: true, maxHeightPx: 320 });
    expect(size.layout.notes.length).toBe(3);
    expect(size.widthPx).toBeCloseTo(1000, 3);
  });

  it('keeps the target in the same place as the piece advances (even on the last notes)', () => {
    const opts = { lookahead: true, maxHeightPx: 320 };
    const start = sizeStaff(many, 1000, opts).layout.notes[0]!.x;
    expect(sizeStaff(many.slice(0, 5), 1000, opts).layout.notes[0]!.x).toBe(start);
    expect(sizeStaff(many.slice(0, 1), 1000, opts).layout.notes[0]!.x).toBe(start);
  });

  it('does not trim when lookahead is off: every note is drawn, shrinking to fit', () => {
    const size = sizeStaff(many.slice(0, 20), 400);
    expect(size.layout.notes.length).toBe(20);
    expect(size.widthPx).toBeLessThanOrEqual(400 + 0.5);
  });

  it('copes with no notes', () => {
    const size = sizeStaff([], 800, { lookahead: true });
    expect(size.layout.notes).toEqual([]);
  });
});
