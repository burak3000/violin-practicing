import { describe, expect, it } from 'vitest';
import { generatePlayingPracticeSequence } from '../sequence/sequence-generator.js';
import { computeDrillPool } from './drilling.js';
import { PlayingPracticeMachine } from './playing-practice.js';

// One-octave G-major scale: G3 A3 B3 C4 D4 E4 F#4 G4 (indices 0-7).
const scale = generatePlayingPracticeSequence({ strings: ['G'], patternType: 'one-octave-scale' });

describe('PlayingPracticeMachine: construction', () => {
  it('throws on an empty notes array', () => {
    expect(() => new PlayingPracticeMachine([])).toThrow(RangeError);
  });

  it('starts active at index 0 by default', () => {
    const machine = new PlayingPracticeMachine(scale);
    expect(machine.state).toEqual({ status: 'active', index: 0, targetNote: scale[0] });
  });

  it('can start at a custom index', () => {
    const machine = new PlayingPracticeMachine(scale, 3);
    expect(machine.state).toEqual({ status: 'active', index: 3, targetNote: scale[3] });
  });
});

describe('PlayingPracticeMachine: success path', () => {
  it('advances to the next note on success', () => {
    const machine = new PlayingPracticeMachine(scale);
    const result = machine.reportOutcome('success');
    expect(result).toEqual({ type: 'advanced', index: 1, targetNote: scale[1] });
    expect(machine.state).toEqual({ status: 'active', index: 1, targetNote: scale[1] });
  });

  it('walks the whole sequence to completion one success at a time', () => {
    const machine = new PlayingPracticeMachine(scale);
    for (let i = 0; i < scale.length - 1; i += 1) {
      const result = machine.reportOutcome('success');
      expect(result).toEqual({ type: 'advanced', index: i + 1, targetNote: scale[i + 1] });
    }
    const final = machine.reportOutcome('success');
    expect(final).toEqual({ type: 'sequence-complete' });
    expect(machine.state).toEqual({ status: 'complete' });
  });

  it('throws if reportOutcome is called after the sequence is already complete', () => {
    const single = generatePlayingPracticeSequence({ strings: ['G'], patternType: 'open-strings' });
    const machine = new PlayingPracticeMachine(single);
    expect(machine.reportOutcome('success')).toEqual({ type: 'sequence-complete' });
    expect(() => machine.reportOutcome('success')).toThrow(/already complete/);
  });
});

describe('PlayingPracticeMachine: failure path (hands off to Drilling)', () => {
  it('reports a failed outcome with the correct failedIndex and a matching drill pool, without advancing', () => {
    const machine = new PlayingPracticeMachine(scale, 3); // C4
    const result = machine.reportOutcome('failure');
    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.failedIndex).toBe(3);
      expect(result.drillPool).toEqual(computeDrillPool(scale, 3));
    }
    // Playing Practice itself does not advance on failure -- it stays
    // "paused" at the failed note until the caller (e.g.
    // PracticeSessionController) explicitly calls resumeAt.
    expect(machine.state).toEqual({ status: 'active', index: 3, targetNote: scale[3] });
  });

  it('repeated failures on the same note are idempotent (no silent advancement)', () => {
    const machine = new PlayingPracticeMachine(scale, 0);
    const first = machine.reportOutcome('failure');
    const second = machine.reportOutcome('failure');
    expect(first).toEqual(second);
    expect(machine.state).toEqual({ status: 'active', index: 0, targetNote: scale[0] });
  });

  it('failing the very first note still produces a valid boundary drill pool (no neighbor-below)', () => {
    const machine = new PlayingPracticeMachine(scale, 0);
    const result = machine.reportOutcome('failure');
    if (result.type === 'failed') {
      expect(result.drillPool.map((p) => p.role)).toEqual(['center', 'neighbor-above']);
    } else {
      throw new Error('expected a failed outcome');
    }
  });

  it('failing the last note still produces a valid boundary drill pool (no neighbor-above)', () => {
    const machine = new PlayingPracticeMachine(scale, scale.length - 1);
    const result = machine.reportOutcome('failure');
    if (result.type === 'failed') {
      expect(result.drillPool.map((p) => p.role)).toEqual(['neighbor-below', 'center']);
    } else {
      throw new Error('expected a failed outcome');
    }
  });
});

describe('PlayingPracticeMachine: resumeAt (Drilling hand-back)', () => {
  it('jumps to a specific index', () => {
    const machine = new PlayingPracticeMachine(scale);
    machine.resumeAt(5);
    expect(machine.state).toEqual({ status: 'active', index: 5, targetNote: scale[5] });
  });

  it('resuming at or past the sequence length resolves to complete rather than throwing', () => {
    const machine = new PlayingPracticeMachine(scale);
    machine.resumeAt(scale.length);
    expect(machine.state).toEqual({ status: 'complete' });
  });

  it('throws on a negative resume index', () => {
    const machine = new PlayingPracticeMachine(scale);
    expect(() => machine.resumeAt(-1)).toThrow(RangeError);
  });

  it('after resuming, reportOutcome continues correctly from the new position', () => {
    const machine = new PlayingPracticeMachine(scale);
    machine.resumeAt(6);
    const result = machine.reportOutcome('success');
    expect(result).toEqual({ type: 'advanced', index: 7, targetNote: scale[7] });
  });

  it('resumeAt can re-enter a completed machine (no "start a new session" ownership per the doc comment)', () => {
    const machine = new PlayingPracticeMachine(scale);
    machine.resumeAt(scale.length);
    expect(machine.state).toEqual({ status: 'complete' });
    machine.resumeAt(0);
    expect(machine.state).toEqual({ status: 'active', index: 0, targetNote: scale[0] });
  });
});
