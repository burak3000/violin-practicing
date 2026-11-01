import { describe, expect, it } from 'vitest';
import { createMeter } from '../abc/abc-score.js';
import { countInBeatsForBars } from './count-in.js';
import { buildTestPiece, consecutiveNotes } from './test-support/piece-builder.js';

const notes = consecutiveNotes([60, 62, 64, 65], 0.25);

describe('countInBeatsForBars', () => {
  it('counts whole bars for a piece that starts on a bar', () => {
    const piece = buildTestPiece(notes);
    expect(countInBeatsForBars(piece, 1)).toBe(4);
    expect(countInBeatsForBars(piece, 2)).toBe(8);
    expect(countInBeatsForBars(piece, 0)).toBe(0);
  });

  it("uses the meter's beats per bar (3/4, 6/8 compound)", () => {
    expect(countInBeatsForBars(buildTestPiece(notes, { meter: createMeter(3, 4) }), 1)).toBe(3);
    expect(countInBeatsForBars(buildTestPiece(notes, { meter: createMeter(6, 8) }), 2)).toBe(4);
  });

  it('takes a whole-beat pickup off the count so the player counts "1 2 3" and comes in on 4', () => {
    const piece = buildTestPiece(notes, { pickupWhole: 0.25 });
    expect(countInBeatsForBars(piece, 1)).toBe(3);
    expect(countInBeatsForBars(piece, 2)).toBe(7);
    const waltz = buildTestPiece(notes, { meter: createMeter(3, 4), pickupWhole: 0.5 });
    expect(countInBeatsForBars(waltz, 1)).toBe(1);
  });

  it('keeps the full bars for an off-beat pickup', () => {
    const piece = buildTestPiece(notes, { pickupWhole: 0.125 });
    expect(countInBeatsForBars(piece, 1)).toBe(4);
  });

  it('never goes negative', () => {
    const piece = buildTestPiece(notes, { pickupWhole: 0.75 });
    expect(countInBeatsForBars(piece, 1)).toBe(1);
    expect(
      countInBeatsForBars(
        buildTestPiece(notes, { meter: createMeter(2, 4), pickupWhole: 0.25 }),
        1,
      ),
    ).toBe(1);
  });

  it('treats nonsense as no count-in', () => {
    expect(countInBeatsForBars(buildTestPiece(notes), Number.NaN)).toBe(0);
    expect(countInBeatsForBars(buildTestPiece(notes), -1)).toBe(0);
  });
});
