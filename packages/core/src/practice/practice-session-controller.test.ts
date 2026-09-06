import { describe, expect, it } from 'vitest';
import { generatePlayingPracticeSequence } from '../sequence/sequence-generator.js';
import { PracticeSessionController } from './practice-session-controller.js';

// One-octave G-major scale: G3 A3 B3 C4 D4 E4 F#4 G4 (indices 0-7).
const scale = generatePlayingPracticeSequence({ strings: ['G'], patternType: 'one-octave-scale' });

describe('PracticeSessionController: playing-practice mode (no failures)', () => {
  it('starts in playing-practice mode at index 0', () => {
    const controller = new PracticeSessionController(scale);
    expect(controller.state).toEqual({ mode: 'playing-practice', index: 0, targetNote: scale[0] });
  });

  it('success advances through playing-practice without ever entering drilling', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('success');
    expect(controller.state).toEqual({ mode: 'playing-practice', index: 1, targetNote: scale[1] });
  });

  it('completes the whole sequence and reaches mode "complete"', () => {
    const controller = new PracticeSessionController(scale);
    for (let i = 0; i < scale.length; i += 1) {
      controller.reportOutcome('success');
    }
    expect(controller.state).toEqual({ mode: 'complete' });
  });

  it('throws if reportOutcome is called after the session is complete', () => {
    const controller = new PracticeSessionController(scale);
    for (let i = 0; i < scale.length; i += 1) {
      controller.reportOutcome('success');
    }
    expect(() => controller.reportOutcome('success')).toThrow(/already complete/);
  });
});

describe('PracticeSessionController: failure correctly triggers Drilling', () => {
  it('a failure on a playing-practice note switches mode to drilling, carrying default config into state', () => {
    const controller = new PracticeSessionController(scale); // will fail index 0 (G3)
    controller.reportOutcome('failure');
    const state = controller.state;
    expect(state.mode).toBe('drilling');
    if (state.mode === 'drilling') {
      // Pool for index 0 has no neighbor-below, so cursor 0 lands on the
      // center (failed) note itself here.
      expect(state.targetNote.note.label).toBe('G3');
      expect(state.consecutiveCorrect).toBe(0);
      expect(state.attemptsUsed).toBe(0);
      expect(state.requiredConsecutiveCorrect).toBe(3); // default
      expect(state.maxAttempts).toBe(12); // default
    }
  });

  it('reflects a custom drilling config in state', () => {
    const controller = new PracticeSessionController(scale, {
      requiredConsecutiveCorrect: 5,
      maxAttempts: 20,
    });
    controller.reportOutcome('failure');
    expect(controller.state).toMatchObject({
      mode: 'drilling',
      requiredConsecutiveCorrect: 5,
      maxAttempts: 20,
    });
  });

  it('failing an interior note enters drilling on the failed note itself', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('success'); // index 0 -> 1
    controller.reportOutcome('success'); // index 1 -> 2
    controller.reportOutcome('success'); // index 2 -> 3 (C4)
    controller.reportOutcome('failure'); // fail C4
    const state = controller.state;
    expect(state.mode).toBe('drilling');
    if (state.mode === 'drilling') {
      // Pool for center index 3 is [neighbor-below B3, center C4, neighbor-above D4];
      // DrillingMachine's cursor now starts on the center entry, so the
      // first note presented is C4 itself (the one just failed) -- see
      // drilling.ts's constructor comment for why a fixed cursor=0 default
      // (which opened on B3, the neighbor below, instead) was corrected.
      expect(state.targetNote.note.label).toBe('C4');
    }
  });

  it('does not advance the underlying Playing Practice index while drilling is in progress', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('failure'); // fail index 0
    controller.reportOutcome('success'); // 1 of 3 required -- still drilling
    expect(controller.state.mode).toBe('drilling');
    controller.reportOutcome('failure'); // resets streak -- still drilling
    expect(controller.state).toMatchObject({
      mode: 'drilling',
      consecutiveCorrect: 0,
      attemptsUsed: 2,
    });
  });
});

describe('PracticeSessionController: mastery hands control back to Playing Practice', () => {
  it('mastering the drill resumes playing-practice at centerIndex + 1', () => {
    const controller = new PracticeSessionController(scale, { requiredConsecutiveCorrect: 1 }); // master in 1
    controller.reportOutcome('failure'); // fail G3 (index 0)
    expect(controller.state.mode).toBe('drilling');
    controller.reportOutcome('success'); // masters immediately (required=1)
    expect(controller.state).toEqual({ mode: 'playing-practice', index: 1, targetNote: scale[1] });
  });

  it('requires the full consecutive-correct streak before mastering (default 3)', () => {
    const controller = new PracticeSessionController(scale); // default requiredConsecutiveCorrect=3
    controller.reportOutcome('failure');
    controller.reportOutcome('success');
    expect(controller.state.mode).toBe('drilling'); // not yet mastered
    controller.reportOutcome('success');
    expect(controller.state.mode).toBe('drilling');
    controller.reportOutcome('success'); // 3rd consecutive
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 1 });
  });

  it('mastering a drill on the last note of the sequence completes the session rather than erroring', () => {
    const lastIndex = scale.length - 1;
    const controller = new PracticeSessionController(scale, { requiredConsecutiveCorrect: 1 });
    for (let i = 0; i < lastIndex; i += 1) {
      controller.reportOutcome('success'); // advance to the last note
    }
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: lastIndex });
    controller.reportOutcome('failure'); // fail the last note
    expect(controller.state.mode).toBe('drilling');
    controller.reportOutcome('success'); // masters
    expect(controller.state).toEqual({ mode: 'complete' });
  });
});

describe('PracticeSessionController: max-attempts cap also hands control back', () => {
  it('hitting the max-attempts cap without mastering still resumes playing-practice at centerIndex + 1', () => {
    const controller = new PracticeSessionController(scale, {
      maxAttempts: 2,
      requiredConsecutiveCorrect: 5,
    });
    controller.reportOutcome('failure'); // enters drilling on G3 (index 0)
    expect(controller.state).toMatchObject({ mode: 'drilling', attemptsUsed: 0 });
    controller.reportOutcome('failure'); // drilling attempt 1/2
    expect(controller.state).toMatchObject({ mode: 'drilling', attemptsUsed: 1 });
    controller.reportOutcome('failure'); // drilling attempt 2/2 -> cap reached
    expect(controller.state).toEqual({ mode: 'playing-practice', index: 1, targetNote: scale[1] });
  });
});

describe('PracticeSessionController: manual skip escape hatch', () => {
  it('skipDrill immediately hands control back to playing-practice at centerIndex + 1', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('failure'); // enters drilling on G3
    controller.reportOutcome('success'); // 1 of 3 required -- nowhere near mastered
    expect(controller.state.mode).toBe('drilling');
    controller.skipDrill();
    expect(controller.state).toEqual({ mode: 'playing-practice', index: 1, targetNote: scale[1] });
  });

  it('works even with zero drilling attempts made', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('failure');
    controller.skipDrill();
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 1 });
  });

  it('skipping a drill on the last note completes the session', () => {
    const lastIndex = scale.length - 1;
    const controller = new PracticeSessionController(scale);
    for (let i = 0; i < lastIndex; i += 1) {
      controller.reportOutcome('success');
    }
    controller.reportOutcome('failure'); // fail the last note
    controller.skipDrill();
    expect(controller.state).toEqual({ mode: 'complete' });
  });

  it('throws if skipDrill is called while not currently drilling', () => {
    const controller = new PracticeSessionController(scale);
    expect(() => controller.skipDrill()).toThrow(/not drilling/);
    controller.reportOutcome('success'); // still playing-practice, not drilling
    expect(() => controller.skipDrill()).toThrow(/not drilling/);
  });

  it('throws if skipDrill is called twice in a row', () => {
    const controller = new PracticeSessionController(scale);
    controller.reportOutcome('failure');
    controller.skipDrill();
    expect(() => controller.skipDrill()).toThrow(/not drilling/);
  });
});

describe('PracticeSessionController: full integration (fail -> drill -> master, fail -> drill -> skip, then finish)', () => {
  it('runs an entire session mixing successes, a failure/drill/master cycle, and a fail/skip cycle', () => {
    const controller = new PracticeSessionController(scale, {
      requiredConsecutiveCorrect: 2,
      maxAttempts: 10,
    });

    // Index 0 (G3): plain success.
    controller.reportOutcome('success');
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 1 });

    // Index 1 (A3): fail, drill (one bad rep along the way), master after 2 consecutive successes.
    controller.reportOutcome('failure');
    expect(controller.state.mode).toBe('drilling');
    controller.reportOutcome('failure'); // consecutiveCorrect stays 0
    controller.reportOutcome('success'); // consecutiveCorrect = 1
    controller.reportOutcome('success'); // consecutiveCorrect = 2 -- mastered, resumeAtIndex = 1 + 1 = 2
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 2 });

    // Index 2 (B3): fail, then use the manual skip escape hatch immediately.
    controller.reportOutcome('failure');
    expect(controller.state.mode).toBe('drilling');
    controller.skipDrill(); // resumeAtIndex = 2 + 1 = 3
    expect(controller.state).toMatchObject({ mode: 'playing-practice', index: 3 });

    // Indices 3-7 (C4..G4): succeed through the rest of the sequence.
    for (let i = 3; i < scale.length; i += 1) {
      controller.reportOutcome('success');
    }
    expect(controller.state).toEqual({ mode: 'complete' });
  });
});
