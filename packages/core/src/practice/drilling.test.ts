import { describe, expect, it } from 'vitest';
import { generatePlayingPracticeSequence } from '../sequence/sequence-generator.js';
import {
  DEFAULT_MAX_DRILL_ATTEMPTS,
  DEFAULT_REQUIRED_CONSECUTIVE_CORRECT,
  DrillingMachine,
  computeDrillPool,
  type DrillPoolNote,
} from './drilling.js';

// One-octave G-major scale: G3 A3 B3 C4 D4 E4 F#4 G4 (indices 0-7). Real
// sequence data (not hand-rolled fixtures) so drill pools reflect actual
// scale-neighbor adjacency, per drilling.ts's own doc comment.
const scale = generatePlayingPracticeSequence({ strings: ['G'], patternType: 'one-octave-scale' });

describe('defaults', () => {
  it('documents the chosen tunables', () => {
    expect(DEFAULT_REQUIRED_CONSECUTIVE_CORRECT).toBe(3);
    expect(DEFAULT_MAX_DRILL_ATTEMPTS).toBe(12);
  });
});

describe('computeDrillPool', () => {
  it('includes both neighbors plus the center for an interior note', () => {
    const pool = computeDrillPool(scale, 3); // C4
    expect(pool.map((p) => p.role)).toEqual(['neighbor-below', 'center', 'neighbor-above']);
    expect(pool.map((p) => p.sequenceIndex)).toEqual([2, 3, 4]);
    expect(pool.map((p) => p.note.note.label)).toEqual(['B3', 'C4', 'D4']);
  });

  it('drops neighbor-below at the start of the sequence', () => {
    const pool = computeDrillPool(scale, 0); // G3, first note
    expect(pool.map((p) => p.role)).toEqual(['center', 'neighbor-above']);
    expect(pool.map((p) => p.note.note.label)).toEqual(['G3', 'A3']);
  });

  it('drops neighbor-above at the end of the sequence', () => {
    const pool = computeDrillPool(scale, scale.length - 1); // G4, last note
    expect(pool.map((p) => p.role)).toEqual(['neighbor-below', 'center']);
    expect(pool.map((p) => p.note.note.label)).toEqual(['F#4', 'G4']);
  });

  it('a single-note sequence yields a pool of just the center, no neighbors on either side', () => {
    const single = generatePlayingPracticeSequence({ strings: ['G'], patternType: 'open-strings' });
    expect(single.length).toBe(1);
    const pool = computeDrillPool(single, 0);
    expect(pool.map((p) => p.role)).toEqual(['center']);
  });

  it('throws when centerIndex is out of bounds', () => {
    expect(() => computeDrillPool(scale, -1)).toThrow(RangeError);
    expect(() => computeDrillPool(scale, scale.length)).toThrow(RangeError);
  });
});

describe('DrillingMachine: construction validation', () => {
  const poolFor = (centerIndex: number) => computeDrillPool(scale, centerIndex);

  it('throws on an empty pool', () => {
    expect(() => new DrillingMachine([])).toThrow(RangeError);
  });

  it('throws if the pool has no "center" entry', () => {
    const noCenter: DrillPoolNote[] = [
      { sequenceIndex: 0, note: scale[0]!, role: 'neighbor-below' },
      { sequenceIndex: 1, note: scale[1]!, role: 'neighbor-above' },
    ];
    expect(() => new DrillingMachine(noCenter)).toThrow(RangeError);
  });

  it('throws if requiredConsecutiveCorrect < 1', () => {
    expect(() => new DrillingMachine(poolFor(3), { requiredConsecutiveCorrect: 0 })).toThrow(
      RangeError,
    );
  });

  it('throws if maxAttempts < 1', () => {
    expect(() => new DrillingMachine(poolFor(3), { maxAttempts: 0 })).toThrow(RangeError);
  });
});

describe('DrillingMachine: mastery path', () => {
  it('masters immediately when requiredConsecutiveCorrect is 1', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 1,
    });
    const result = machine.reportOutcome('success');
    expect(result).toEqual({ type: 'mastered', resumeAtIndex: 4 }); // centerIndex(3) + 1
    expect(machine.isFinished).toBe(true);
  });

  it('requires N consecutive successes with the default config (3)', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3));
    expect(machine.reportOutcome('success').type).toBe('continue');
    expect(machine.reportOutcome('success').type).toBe('continue');
    const third = machine.reportOutcome('success');
    expect(third).toEqual({ type: 'mastered', resumeAtIndex: 4 });
  });

  it('a failure resets the consecutive-correct streak, delaying mastery', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 2,
    });
    expect(machine.reportOutcome('success').type).toBe('continue'); // 1
    expect(machine.reportOutcome('failure').type).toBe('continue'); // reset to 0
    expect(machine.consecutiveCorrectCount).toBe(0);
    expect(machine.reportOutcome('success').type).toBe('continue'); // 1 again
    expect(machine.reportOutcome('success')).toMatchObject({ type: 'mastered' }); // 2
  });

  it('opens on the failed note itself, then rotates through its neighbors round-robin', () => {
    // Pool for centerIndex 3 is [neighbor-below B3, center C4, neighbor-above D4].
    // The cursor starts at the pool's center entry (index 1), not pool[0] --
    // drilling opens on the note the user actually just failed. See this
    // class's constructor comment for why a fixed cursor=0 default (which
    // opened on the neighbor *below* instead) was corrected during Phase 2
    // verification.
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 100,
      maxAttempts: 100,
    });
    expect(machine.currentNote.role).toBe('center');
    machine.reportOutcome('success');
    expect(machine.currentNote.role).toBe('neighbor-above');
    machine.reportOutcome('success');
    expect(machine.currentNote.role).toBe('neighbor-below');
    machine.reportOutcome('success');
    expect(machine.currentNote.role).toBe('center'); // wraps back around
  });

  it('opens on the center even when there is no neighbor-below (start-of-sequence boundary)', () => {
    // Pool for centerIndex 0 is [center G3, neighbor-above A3] -- center is
    // already at array index 0 here, so this boundary case was never
    // affected by the cursor-start bug, but it's worth pinning down that
    // both boundary and interior pools now agree on "open on the center."
    const machine = new DrillingMachine(computeDrillPool(scale, 0));
    expect(machine.currentNote.role).toBe('center');
  });
});

describe('DrillingMachine: max-attempts cap (bounded drilling)', () => {
  it('force-ends as max-attempts-reached when the cap is hit without mastering', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 3,
      maxAttempts: 4,
    });
    // success, fail, success, success: never 3-in-a-row, hits the cap at attempt 4.
    expect(machine.reportOutcome('success').type).toBe('continue');
    expect(machine.reportOutcome('failure').type).toBe('continue');
    expect(machine.reportOutcome('success').type).toBe('continue');
    const fourth = machine.reportOutcome('success');
    expect(fourth).toEqual({ type: 'max-attempts-reached', resumeAtIndex: 4 });
    expect(machine.attemptsUsedCount).toBe(4);
    expect(machine.consecutiveCorrectCount).toBe(2); // did not master
    expect(machine.isFinished).toBe(true);
  });

  it('caps on an all-failure streak too', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), { maxAttempts: 2 });
    expect(machine.reportOutcome('failure').type).toBe('continue');
    expect(machine.reportOutcome('failure')).toEqual({
      type: 'max-attempts-reached',
      resumeAtIndex: 4,
    });
  });

  it('mastery takes precedence over the cap when both are reached on the same attempt', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 3,
      maxAttempts: 3,
    });
    machine.reportOutcome('success');
    machine.reportOutcome('success');
    const third = machine.reportOutcome('success'); // hits both required(3) and cap(3) simultaneously
    expect(third).toEqual({ type: 'mastered', resumeAtIndex: 4 });
  });

  it('resumeAtIndex is centerIndex + 1 regardless of which boundary the pool is at', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 0), { maxAttempts: 1 }); // G3, no neighbor-below
    const result = machine.reportOutcome('failure');
    expect(result).toEqual({ type: 'max-attempts-reached', resumeAtIndex: 1 });
  });

  it('further calls after the cap is reached throw', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), { maxAttempts: 1 });
    machine.reportOutcome('failure');
    expect(machine.isFinished).toBe(true);
    expect(() => machine.reportOutcome('success')).toThrow(/already finished/);
    expect(() => machine.skip()).toThrow(/already finished/);
  });
});

describe('DrillingMachine: manual skip escape hatch', () => {
  it('ends drilling immediately regardless of progress', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3));
    machine.reportOutcome('success'); // 1 of 3 required -- nowhere near mastered
    const result = machine.skip();
    expect(result).toEqual({ type: 'skipped', resumeAtIndex: 4 });
    expect(machine.isFinished).toBe(true);
  });

  it('can be called with zero attempts made', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3));
    const result = machine.skip();
    expect(result).toEqual({ type: 'skipped', resumeAtIndex: 4 });
    expect(machine.attemptsUsedCount).toBe(0);
  });

  it('does not itself count as an attempt', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3));
    machine.reportOutcome('failure');
    expect(machine.attemptsUsedCount).toBe(1);
    machine.skip();
    expect(machine.attemptsUsedCount).toBe(1);
  });

  it('throws if called again after already skipped, or after reportOutcome', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3));
    machine.skip();
    expect(() => machine.skip()).toThrow(/already finished/);
    expect(() => machine.reportOutcome('success')).toThrow(/already finished/);
  });

  it('is available at any point during an in-progress drill, not just at the start', () => {
    const machine = new DrillingMachine(computeDrillPool(scale, 3), {
      requiredConsecutiveCorrect: 10,
    });
    machine.reportOutcome('success');
    machine.reportOutcome('success');
    machine.reportOutcome('failure');
    expect(machine.isFinished).toBe(false);
    const result = machine.skip();
    expect(result.type).toBe('skipped');
  });
});
