import { describe, expect, it } from 'vitest';
import { buildPlayAlongPlan } from './play-along-plan.js';
import type { PlayAlongNote } from './play-along-plan.js';
import { PlayAlongSession } from './play-along-session.js';
import type { PlayAlongNoteResult } from './play-along-session.js';
import {
  NOTICEABLE_TENDENCY_MS,
  TENDENCY_MIN_HITS,
  TENDENCY_THRESHOLD_MS,
  beatUnitSymbol,
  describeMiss,
  describeNoteLocation,
  describeSummary,
  describeTendency,
  formatTempoMark,
  summarizePlayAlongResults,
} from './play-along-summary.js';
import type { PlayAlongSummary } from './play-along-summary.js';
import { buildTestPiece, consecutiveNotes } from './test-support/piece-builder.js';
import { endOfPiece, performPlan, runSession } from './test-support/frames.js';

const MINUS = '−';

function note(overrides: Partial<PlayAlongNote> = {}): PlayAlongNote {
  return {
    index: 0,
    midi: 66,
    frequencyHz: 369.99,
    label: 'F♯4',
    startWhole: 0,
    durationWhole: 0.25,
    onsetMs: 0,
    endMs: 1000,
    barNumber: 3,
    beatInBar: 2,
    beatMs: 1000,
    ...overrides,
  };
}

const hitAt = (index: number, timingOffsetMs: number): PlayAlongNoteResult => ({
  index,
  status: 'hit',
  timingOffsetMs,
});
const missedAt = (index: number): PlayAlongNoteResult => ({
  index,
  status: 'missed',
  reason: 'not-played',
  timingOffsetMs: undefined,
});
const pendingAt = (index: number): PlayAlongNoteResult => ({ index, status: 'pending' });

function summaryWith(partial: Partial<PlayAlongSummary>): PlayAlongSummary {
  return {
    total: 16,
    hits: 12,
    misses: 4,
    pending: 0,
    accuracy: 0.75,
    meanOffsetMs: 0,
    missedIndices: [],
    tendency: undefined,
    ...partial,
  };
}

describe('beatUnitSymbol / formatTempoMark', () => {
  it('uses note glyphs for the common beats', () => {
    expect(beatUnitSymbol(1 / 4)).toBe('♩');
    expect(beatUnitSymbol(3 / 8)).toBe('♩.');
    expect(beatUnitSymbol(1 / 8)).toBe('♪');
    expect(beatUnitSymbol(3 / 16)).toBe('♪.');
  });

  it('falls back to a reduced fraction of a whole note for any other beat', () => {
    expect(beatUnitSymbol(1 / 2)).toBe('1/2');
    expect(beatUnitSymbol(3 / 4)).toBe('3/4');
    expect(beatUnitSymbol(1 / 16)).toBe('1/16');
    expect(beatUnitSymbol(1)).toBe('1/1');
    expect(beatUnitSymbol(3 / 2)).toBe('3/2');
    expect(beatUnitSymbol(1 / 3)).toBe('1/3');
    expect(beatUnitSymbol(5 / 32)).toBe('5/32');
  });

  it('never throws on an odd beat length', () => {
    expect(beatUnitSymbol(0.123456789)).toBe('0.123');
    expect(() => beatUnitSymbol(Number.NaN)).not.toThrow();
    expect(() => beatUnitSymbol(0)).not.toThrow();
  });

  it('formats tempo marks', () => {
    expect(formatTempoMark({ beatLengthWhole: 0.25, bpm: 120 })).toBe('♩ = 120');
    expect(formatTempoMark({ beatLengthWhole: 3 / 8, bpm: 59.6 })).toBe('♩. = 60');
    expect(formatTempoMark({ beatLengthWhole: 1 / 2, bpm: 60 })).toBe('1/2 = 60');
  });
});

describe('describeMiss', () => {
  it('says how late', () => {
    const result: PlayAlongNoteResult = {
      index: 0,
      status: 'missed',
      reason: 'late',
      timingOffsetMs: 310,
    };
    expect(describeMiss(note(), result)).toBe('Bar 3, beat 2 · F♯4 — late by 310 ms');
  });

  it('says how early, with a true minus sign', () => {
    const result: PlayAlongNoteResult = {
      index: 0,
      status: 'missed',
      reason: 'early',
      timingOffsetMs: -240,
    };
    expect(describeMiss(note(), result)).toBe(
      `Bar 3, beat 2 · F♯4 — started early (${MINUS}240 ms)`,
    );
    expect(describeMiss(note(), result)).not.toContain('-240');
  });

  it('rounds milliseconds', () => {
    const result: PlayAlongNoteResult = {
      index: 0,
      status: 'missed',
      reason: 'late',
      timingOffsetMs: 310.6,
    };
    expect(describeMiss(note(), result)).toContain('late by 311 ms');
  });

  it('describes a wrong note and a note that was not played', () => {
    expect(
      describeMiss(note(), {
        index: 0,
        status: 'missed',
        reason: 'wrong-pitch',
        timingOffsetMs: undefined,
      }),
    ).toBe('Bar 3, beat 2 · F♯4 — played the wrong note');
    expect(describeMiss(note(), missedAt(0))).toBe('Bar 3, beat 2 · F♯4 — not played');
  });

  it('copes with a late/early miss that carries no offset', () => {
    expect(
      describeMiss(note(), {
        index: 0,
        status: 'missed',
        reason: 'late',
        timingOffsetMs: undefined,
      }),
    ).toBe('Bar 3, beat 2 · F♯4 — late');
    expect(
      describeMiss(note(), {
        index: 0,
        status: 'missed',
        reason: 'early',
        timingOffsetMs: undefined,
      }),
    ).toBe('Bar 3, beat 2 · F♯4 — started early');
  });

  it('calls bar 0 the pickup', () => {
    expect(describeMiss(note({ barNumber: 0, beatInBar: 4 }), missedAt(0))).toBe(
      'Pickup, beat 4 · F♯4 — not played',
    );
  });

  it('writes fractional beats without trailing zeros', () => {
    expect(describeNoteLocation(note({ beatInBar: 2.5 }))).toBe('Bar 3, beat 2.5 · F♯4');
    expect(describeNoteLocation(note({ beatInBar: 1.33 }))).toBe('Bar 3, beat 1.33 · F♯4');
    expect(describeNoteLocation(note({ beatInBar: 3 }))).toBe('Bar 3, beat 3 · F♯4');
  });

  it('gives hits and pending notes a sensible line too', () => {
    expect(describeMiss(note(), hitAt(0, 12))).toBe('Bar 3, beat 2 · F♯4 — on time');
    expect(describeMiss(note(), pendingAt(0))).toBe('Bar 3, beat 2 · F♯4 — not reached yet');
  });
});

describe('summarizePlayAlongResults', () => {
  it('counts hits, misses and pending, and averages the signed offsets of the hits', () => {
    const summary = summarizePlayAlongResults([
      hitAt(0, 10),
      hitAt(1, 30),
      missedAt(2),
      pendingAt(3),
      hitAt(4, -20),
      missedAt(5),
    ]);
    expect(summary).toMatchObject({
      total: 6,
      hits: 3,
      misses: 2,
      pending: 1,
      missedIndices: [2, 5],
    });
    expect(summary.accuracy).toBeCloseTo(0.5, 9);
    expect(summary.meanOffsetMs).toBeCloseTo(20 / 3, 9);
  });

  it('has no mean offset and no tendency without hits', () => {
    const summary = summarizePlayAlongResults([missedAt(0), pendingAt(1)]);
    expect(summary.meanOffsetMs).toBeUndefined();
    expect(summary.tendency).toBeUndefined();
    expect(summary.accuracy).toBe(0);
  });

  it('handles an empty piece', () => {
    expect(summarizePlayAlongResults([])).toMatchObject({
      total: 0,
      hits: 0,
      accuracy: 0,
      tendency: undefined,
    });
  });

  it('reports a tendency only from 4 hits, and only beyond 25 ms', () => {
    expect(TENDENCY_MIN_HITS).toBe(4);
    expect(TENDENCY_THRESHOLD_MS).toBe(25);
    const hitsWith = (count: number, offset: number) =>
      Array.from({ length: count }, (_, i) => hitAt(i, offset));
    expect(summarizePlayAlongResults(hitsWith(3, 100)).tendency).toBeUndefined();
    expect(summarizePlayAlongResults(hitsWith(4, 100)).tendency).toBe('late');
    expect(summarizePlayAlongResults(hitsWith(4, -100)).tendency).toBe('early');
    expect(summarizePlayAlongResults(hitsWith(4, 25)).tendency).toBe('steady'); // exactly 25 is not beyond it
    expect(summarizePlayAlongResults(hitsWith(4, 26)).tendency).toBe('late');
    expect(summarizePlayAlongResults(hitsWith(4, -25)).tendency).toBe('steady');
    expect(summarizePlayAlongResults(hitsWith(4, 0)).tendency).toBe('steady');
  });

  it('lets early and late hits cancel (a player who is sometimes early, sometimes late is steady on average)', () => {
    const summary = summarizePlayAlongResults([
      hitAt(0, 80),
      hitAt(1, -80),
      hitAt(2, 70),
      hitAt(3, -70),
    ]);
    expect(summary.tendency).toBe('steady');
  });
});

describe('describeSummary', () => {
  it('reads "12 of 16 notes on time (75%)"', () => {
    expect(describeSummary(summaryWith({}))).toBe('12 of 16 notes on time (75%)');
  });

  it('shows 100% only for a perfect run and 0% only for none', () => {
    expect(describeSummary(summaryWith({ hits: 16, accuracy: 1 }))).toBe(
      '16 of 16 notes on time (100%)',
    );
    expect(describeSummary(summaryWith({ hits: 199, total: 200, accuracy: 199 / 200 }))).toBe(
      '199 of 200 notes on time (99%)',
    );
    expect(describeSummary(summaryWith({ hits: 1, total: 300, accuracy: 1 / 300 }))).toBe(
      '1 of 300 notes on time (1%)',
    );
    expect(describeSummary(summaryWith({ hits: 0, total: 8, accuracy: 0 }))).toBe(
      '0 of 8 notes on time (0%)',
    );
  });

  it('is grammatical for one note, and mentions notes not reached', () => {
    expect(describeSummary(summaryWith({ hits: 1, total: 1, accuracy: 1 }))).toBe(
      '1 of 1 note on time (100%)',
    );
    expect(describeSummary(summaryWith({ hits: 4, total: 8, accuracy: 0.5, pending: 4 }))).toBe(
      '4 of 8 notes on time (50%) · 4 not reached',
    );
  });

  it('has something to say for an empty piece', () => {
    expect(describeSummary(summaryWith({ total: 0, hits: 0, accuracy: 0 }))).toBe(
      'No notes to play',
    );
  });
});

describe('describeTendency', () => {
  it('describes a small lateness', () => {
    expect(describeTendency(summaryWith({ tendency: 'late', meanOffsetMs: 45 }))).toBe(
      'You tend to play a little late (+45 ms on average)',
    );
  });

  it('describes a small earliness with a true minus sign', () => {
    expect(describeTendency(summaryWith({ tendency: 'early', meanOffsetMs: -45.4 }))).toBe(
      `You tend to play a little early (${MINUS}45 ms on average)`,
    );
  });

  it('says "noticeably" from 100 ms', () => {
    expect(NOTICEABLE_TENDENCY_MS).toBe(100);
    expect(describeTendency(summaryWith({ tendency: 'late', meanOffsetMs: 130 }))).toBe(
      'You tend to play noticeably late (+130 ms on average)',
    );
    expect(describeTendency(summaryWith({ tendency: 'early', meanOffsetMs: -100 }))).toBe(
      `You tend to play noticeably early (${MINUS}100 ms on average)`,
    );
  });

  it('compliments a steady player', () => {
    expect(describeTendency(summaryWith({ tendency: 'steady', meanOffsetMs: 3 }))).toBe(
      'Your timing was nicely steady',
    );
  });

  it('says nothing when there were too few hits to tell', () => {
    expect(
      describeTendency(summaryWith({ tendency: undefined, meanOffsetMs: 80 })),
    ).toBeUndefined();
  });
});

describe('the helpers on a real run', () => {
  it('turns a performance with a skipped, a wrong and a late note into readable lines', () => {
    const plan = buildPlayAlongPlan(
      buildTestPiece(consecutiveNotes([69, 71, 73, 74, 76, 78, 80, 81], 0.25)),
    );
    const session = new PlayAlongSession(plan);
    const sounding = performPlan(plan, {
      perNote: { 1: { skip: true }, 3: { semitones: 1 }, 6: { lateMs: 350 } },
    });
    runSession(session, sounding, { zeroMs: 5000, toMs: endOfPiece(plan) });

    const summary = session.summary();
    expect(summary.missedIndices).toEqual([1, 3, 6]);
    const lines = summary.missedIndices.map((i) =>
      describeMiss(plan.notes[i]!, session.results[i]!),
    );
    expect(lines[0]).toBe('Bar 1, beat 2 · B4 — not played');
    expect(lines[1]).toBe('Bar 1, beat 4 · D5 — played the wrong note');
    expect(lines[2]).toMatch(/^Bar 2, beat 3 · G♯5 — late by 3\d\d ms$/);
    expect(describeSummary(summary)).toBe('5 of 8 notes on time (63%)');
  });
});
