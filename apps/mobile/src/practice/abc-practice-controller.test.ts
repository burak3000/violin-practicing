import { describe, expect, it } from 'vitest';
import { analyzeTunerReading, type PitchReading } from '@violin/core';
import {
  AbcPracticeController,
  INITIAL_ABC_PRACTICE_VIEW_STATE,
  type AbcFilePicker,
  type AbcPracticeViewState,
} from './abc-practice-controller';

const voiced = (frequencyHz: number): PitchReading => ({
  voiced: true,
  frequencyHz,
  confidence: 0.9,
});
const unvoiced: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

// Equal-tempered frequencies at A4 = 440.
const HZ = { G3: 195.998, A3: 220, B3: 246.942, C4: 261.626, D4: 293.665, E4: 329.628, A4: 440 };

const noPicker: AbcFilePicker = async () => undefined;

function importState(
  state: AbcPracticeViewState,
): Extract<AbcPracticeViewState, { phase: 'import' }> {
  if (state.phase !== 'import') throw new Error(`expected import phase, got ${state.phase}`);
  return state;
}
function activeSession(state: AbcPracticeViewState) {
  if (state.phase !== 'session' || state.session.kind !== 'active') {
    throw new Error(`expected an active session, got ${JSON.stringify(state)}`);
  }
  return state.session;
}

/** Feeds `ms` of `reading` at a fixed 20ms hop, advancing the caller's clock. */
function makePlayer(controller: AbcPracticeController) {
  let t = 1000;
  return (reading: PitchReading, ms: number): void => {
    const end = t + ms;
    for (; t < end; t += 20) {
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), t);
    }
  };
}

describe('AbcPracticeController: initial state', () => {
  it('starts on the import screen with nothing loaded and Start disabled', () => {
    const state = importState(new AbcPracticeController(noPicker).getViewState());
    expect(state).toMatchObject({
      fileName: undefined,
      loading: false,
      tunes: [],
      selectedTuneIndex: undefined,
      transposeSemitones: 0,
      summaryText: '',
      warnings: [],
      error: undefined,
      canStart: false,
    });
  });

  it("INITIAL_ABC_PRACTICE_VIEW_STATE (App.tsx's useState initializer) matches a fresh controller", () => {
    expect(INITIAL_ABC_PRACTICE_VIEW_STATE).toEqual(
      new AbcPracticeController(noPicker).getViewState(),
    );
  });

  it('getViewState() never invokes onChange', () => {
    let calls = 0;
    const controller = new AbcPracticeController(noPicker, { onChange: () => (calls += 1) });
    controller.getViewState();
    expect(calls).toBe(0);
  });

  it('start() before anything is imported is a no-op', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.start();
    expect(controller.getViewState().phase).toBe('import');
  });
});

describe('AbcPracticeController: loading a file', () => {
  it('loads a tune, selects it, and is ready to start', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('scale.abc', 'X:1\nT:Scale\nK:G\nG, A, B, C D\n');
    const state = importState(controller.getViewState());
    expect(state.fileName).toBe('scale.abc');
    expect(state.tunes).toEqual([{ index: 0, label: '1: Scale' }]);
    expect(state.selectedTuneIndex).toBe(0);
    expect(state.canStart).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.summaryText).toBe('Scale · key G\n5 notes, G3 to D4\nG3 A3 B3 C4 D4');
  });

  it('reports a file that is not ABC', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('notes.txt', 'shopping list\nmilk\neggs');
    const state = importState(controller.getViewState());
    expect(state.canStart).toBe(false);
    expect(state.tunes).toEqual([]);
    expect(state.error).toContain('No ABC tune');
  });

  it('lists every tune in a tune book and selects the first one that has notes', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('book.abc', 'X:1\nT:Empty\nK:C\n\nX:2\nT:Real\nK:C\nC D E\n');
    const state = importState(controller.getViewState());
    expect(state.tunes.map((t) => t.label)).toEqual(['1: Empty', '2: Real']);
    expect(state.selectedTuneIndex).toBe(1);
    expect(state.canStart).toBe(true);
  });

  it('switches tune with selectTune and ignores an unknown index', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('book.abc', 'X:1\nT:One\nK:C\nC D\n\nX:2\nT:Two\nK:C\nE F G\n');
    controller.selectTune(1);
    expect(importState(controller.getViewState()).summaryText).toContain('Two');
    controller.selectTune(99);
    expect(importState(controller.getViewState()).selectedTuneIndex).toBe(1);
  });

  it("surfaces the parser's warnings (a chord is reduced to its top note)", () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('chords.abc', 'X:1\nK:C\n[CEG] D\n');
    const state = importState(controller.getViewState());
    expect(state.warnings.some((w) => w.includes('chord'))).toBe(true);
    expect(state.canStart).toBe(true);
  });

  it('resets the transposition when a new file is loaded', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('a.abc', 'X:1\nK:C\nC D\n');
    controller.setTranspose(12);
    controller.loadText('b.abc', 'X:1\nK:C\nE F\n');
    expect(importState(controller.getViewState()).transposeSemitones).toBe(0);
  });
});

describe('AbcPracticeController: range handling', () => {
  it('refuses a tune that is too low, explains why, and accepts it once transposed', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('low.abc', 'X:1\nK:C\nC, D, E,\n');
    let state = importState(controller.getViewState());
    expect(state.canStart).toBe(false);
    expect(state.error).toContain('up an octave');

    controller.start(); // refused: stays on the import screen
    expect(controller.getViewState().phase).toBe('import');

    controller.setTranspose(12);
    state = importState(controller.getViewState());
    expect(state.canStart).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.summaryText).toContain('C4 D4 E4');
  });
});

describe('AbcPracticeController: importFile via the injected picker', () => {
  it('loads whatever the picker returns', async () => {
    const controller = new AbcPracticeController(async () => ({
      name: 'tune.abc',
      text: 'X:1\nK:C\nC D E\n',
    }));
    await controller.importFile();
    const state = importState(controller.getViewState());
    expect(state.fileName).toBe('tune.abc');
    expect(state.canStart).toBe(true);
    expect(state.loading).toBe(false);
  });

  it('leaves everything as it was when the user cancels the picker', async () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('first.abc', 'X:1\nK:C\nC\n');
    const before = controller.getViewState();
    await controller.importFile();
    expect(controller.getViewState()).toEqual(before);
  });

  it("shows the picker's error message and clears any previous tune", async () => {
    const controller = new AbcPracticeController(async () => {
      throw new Error('Could not read "x.abc": denied');
    });
    controller.loadText('first.abc', 'X:1\nK:C\nC\n');
    await controller.importFile();
    const state = importState(controller.getViewState());
    expect(state.error).toBe('Could not read "x.abc": denied');
    expect(state.tunes).toEqual([]);
    expect(state.canStart).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('reports loading while the picker is open and ignores a second import in the meantime', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const controller = new AbcPracticeController(
      () =>
        new Promise((resolve) => {
          calls += 1;
          release = () => resolve({ name: 'late.abc', text: 'X:1\nK:C\nC\n' });
        }),
    );
    const first = controller.importFile();
    expect(importState(controller.getViewState()).loading).toBe(true);
    await controller.importFile(); // ignored
    expect(calls).toBe(1);
    release!();
    await first;
    expect(importState(controller.getViewState()).loading).toBe(false);
    expect(importState(controller.getViewState()).fileName).toBe('late.abc');
  });

  it('pushes changes through onChange', async () => {
    const states: AbcPracticeViewState[] = [];
    const controller = new AbcPracticeController(
      async () => ({ name: 't.abc', text: 'X:1\nK:C\nC\n' }),
      { onChange: (s) => states.push(s) },
    );
    await controller.importFile();
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)).toEqual(controller.getViewState());
  });
});

describe('AbcPracticeController: practicing a tune', () => {
  function started(abc: string): {
    controller: AbcPracticeController;
    play: ReturnType<typeof makePlayer>;
  } {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', abc);
    controller.start();
    return { controller, play: makePlayer(controller) };
  }

  it('starts on the first note, previews the next ones, and offers "skip this note"', () => {
    const { controller } = started('X:1\nK:C\nG, A, B, C D E\n');
    const session = activeSession(controller.getViewState());
    expect(session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'G3',
      progressText: 'Note 1 of 6',
      upcomingText: 'Next: A3 B3 C4 D4',
      showGiveUpButton: true,
      showSkipDrillButton: false,
    });
  });

  it('walks the whole tune note by note to the complete screen', () => {
    const { controller, play } = started('X:1\nK:C\nG, A, B,\n');

    play(voiced(HZ.G3), 300);
    expect(activeSession(controller.getViewState()).banner).toEqual({
      text: 'Nice!',
      tone: 'success',
    });
    play(unvoiced, 800); // banner pause elapses -> next target
    let session = activeSession(controller.getViewState());
    expect(session).toMatchObject({ targetNoteLabel: 'A3', progressText: 'Note 2 of 3' });
    expect(session.upcomingText).toBe('Next: B3');

    play(voiced(HZ.A3), 300);
    play(unvoiced, 800);
    session = activeSession(controller.getViewState());
    expect(session).toMatchObject({ targetNoteLabel: 'B3', upcomingText: '' });

    play(voiced(HZ.B3), 300);
    expect(controller.getViewState()).toEqual({
      phase: 'session',
      session: { kind: 'complete' },
    });
  });

  it('does not let a note still being held from the last target satisfy the next, identical one', () => {
    const { controller, play } = started('X:1\nK:C\nA A\n');

    play(voiced(HZ.A4), 300); // first A succeeds
    expect(activeSession(controller.getViewState()).banner?.text).toBe('Nice!');
    play(voiced(HZ.A4), 1500); // keeps holding straight through the pause and into the next target
    const session = activeSession(controller.getViewState());
    expect(session).toMatchObject({ targetNoteLabel: 'A4', progressText: 'Note 2 of 2' });
    expect(session.dwellFraction).toBe(0);

    play(unvoiced, 60); // bow change / gap: released
    play(voiced(HZ.A4), 300);
    expect(controller.getViewState()).toEqual({ phase: 'session', session: { kind: 'complete' } });
  });

  it('a manual give-up drills the missed note (no release needed: nothing was credited), and hides the preview while drilling', () => {
    const { controller, play } = started('X:1\nK:C\nC D E\n');
    controller.giveUp();
    let session = activeSession(controller.getViewState());
    expect(session).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'C4',
      showSkipDrillButton: true,
      showGiveUpButton: false,
      upcomingText: '',
    });

    // The drill opens on the same pitch just given up on; playing it counts straight away.
    play(voiced(HZ.C4), 300);
    session = activeSession(controller.getViewState());
    expect(session).toMatchObject({ mode: 'drilling' });
    expect(session.progressText).toContain('1 of 3 correct in a row');
  });

  it('skipping the drill resumes the tune on the note after the missed one', () => {
    const { controller } = started('X:1\nK:C\nC D E\n');
    controller.giveUp();
    controller.skipDrill();
    expect(activeSession(controller.getViewState())).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'D4',
      progressText: 'Note 2 of 3',
      upcomingText: 'Next: E4',
    });
  });

  it('times out into Drilling when nothing in tune is played', () => {
    const { controller, play } = started('X:1\nK:C\nC D\n');
    play(voiced(500), 10_500);
    expect(activeSession(controller.getViewState())).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'C4',
    });
  });

  it('restart() returns to the import screen with the file and selection intact', () => {
    const { controller } = started('X:1\nT:Keep\nK:C\nC D\n');
    controller.restart();
    const state = importState(controller.getViewState());
    expect(state.fileName).toBe('t.abc');
    expect(state.canStart).toBe(true);
    expect(state.summaryText).toContain('Keep');
  });

  it('is a no-op to feed frames before a session starts', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', 'X:1\nK:C\nC\n');
    expect(() =>
      controller.handleAnalysisFrame(voiced(HZ.C4), analyzeTunerReading(voiced(HZ.C4)), 0),
    ).not.toThrow();
    expect(controller.getViewState().phase).toBe('import');
  });
});
