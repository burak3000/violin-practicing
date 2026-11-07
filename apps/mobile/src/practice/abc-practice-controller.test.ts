import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAY_ALONG_LEAD_MS,
  MAX_TEMPO_BPM,
  MIN_TEMPO_BPM,
  analyzeTunerReading,
  buildAbcPracticeSequence,
  buildPlayAlongPlan,
  describeTempoSettings,
  midiToFrequencyHz,
  parseAbc,
  type PitchReading,
  type PlayAlongPlan,
} from '@violin/core';
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

    controller.start(); // refused: stays on the import screen (in either style)
    expect(controller.getViewState().phase).toBe('import');
    controller.setStyle('wait');
    controller.start();
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

describe('AbcPracticeController: practicing a tune (Wait for me)', () => {
  function started(abc: string): {
    controller: AbcPracticeController;
    play: ReturnType<typeof makePlayer>;
  } {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', abc);
    controller.setStyle('wait');
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

  it('is a no-op to feed frames before anything starts', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', 'X:1\nK:C\nC\n');
    expect(() =>
      controller.handleAnalysisFrame(voiced(HZ.C4), analyzeTunerReading(voiced(HZ.C4)), 0),
    ).not.toThrow();
    expect(controller.getViewState().phase).toBe('import');
  });
});

describe('AbcPracticeController: staff notes (for the Letters/Staff display)', () => {
  function started(abc: string): AbcPracticeController {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', abc);
    controller.setStyle('wait');
    controller.start();
    return controller;
  }

  it('gives the target first, then every following note (the staff decides how many fit), spelled as written', () => {
    const controller = started('X:1\nK:Bb\nB c d e f g\n');
    const session = activeSession(controller.getViewState());
    // The text line still names four (spelled as the sheet spells them: E-flat, not D-sharp);
    // the staff is handed everything that follows.
    expect(session.upcomingText).toBe('Next: C5 D5 E♭5 F5');
    expect(session.staffNotes).toEqual([
      { spelling: { letter: 'B', accidental: -1, octave: 4 }, role: 'target' },
      { spelling: { letter: 'C', accidental: 0, octave: 5 }, role: 'upcoming' },
      { spelling: { letter: 'D', accidental: 0, octave: 5 }, role: 'upcoming' },
      { spelling: { letter: 'E', accidental: -1, octave: 5 }, role: 'upcoming' },
      { spelling: { letter: 'F', accidental: 0, octave: 5 }, role: 'upcoming' },
      { spelling: { letter: 'G', accidental: 0, octave: 5 }, role: 'upcoming' },
    ]);
  });

  it('looks far ahead on a long piece, capped at 40 notes after the target', () => {
    const scale = Array.from({ length: 60 }, () => 'G').join(' ');
    const session = activeSession(started(`X:1\nK:C\n${scale}\n`).getViewState());
    expect(session.staffNotes).toHaveLength(41);
    expect(session.staffNotes.filter((n) => n.role === 'upcoming')).toHaveLength(40);
  });

  it('shows only the target while drilling (the pool rotates, it does not walk the piece)', () => {
    const controller = started('X:1\nK:C\nC D E\n');
    controller.giveUp();
    const session = activeSession(controller.getViewState());
    expect(session.mode).toBe('drilling');
    expect(session.staffNotes).toEqual([
      { spelling: { letter: 'C', accidental: 0, octave: 4 }, role: 'target' },
    ]);
  });

  it('follows the tune: after a note succeeds and the pause elapses, the staff moves on', () => {
    const controller = started('X:1\nK:C\nG, A, B,\n');
    const play = makePlayer(controller);
    play(voiced(HZ.G3), 300);
    // During the "Nice!" pause the staff still shows the note just played, like the letter does.
    expect(activeSession(controller.getViewState()).staffNotes[0]!.spelling.letter).toBe('G');
    play(unvoiced, 800);
    expect(activeSession(controller.getViewState()).staffNotes[0]!.spelling.letter).toBe('A');
  });
});

// ---------------------------------------------------------------------------------
// Practice style, tempo and count-in (import-screen settings)
// ---------------------------------------------------------------------------------

/** Two bars of quarter notes with a written tempo of 92 and a stated meter. */
const TUNE_92 = 'X:1\nT:Four\nM:4/4\nL:1/4\nQ:1/4=92\nK:C\nC D E F|G A B c|\n';
/** The same notes with nothing said about tempo or meter. */
const TUNE_BARE = 'X:1\nT:Bare\nL:1/4\nK:C\nC D E F|G A B c|\n';
/** F major: a B-flat in the first bar. */
const TUNE_F = 'X:1\nT:Eff\nM:4/4\nL:1/4\nQ:1/4=60\nK:F\nF G A B|c d e f|\n';

function importFor(abc: string, tweak?: (c: AbcPracticeController) => void) {
  const controller = new AbcPracticeController(noPicker);
  controller.loadText('t.abc', abc);
  tweak?.(controller);
  return controller;
}
/** The tempo block, flattened: core's `TempoSettings` (what the control shows) plus the controller's own fields. */
function tempoOf(controller: AbcPracticeController) {
  const tempo = importState(controller.getViewState()).tempo;
  if (!tempo) throw new Error('expected tempo settings');
  const { settings, ...own } = tempo;
  return { ...settings, ...own };
}

describe('AbcPracticeController: practice style and the tempo read from the file', () => {
  it('defaults to Play along with a one-bar count-in', () => {
    const state = importState(importFor(TUNE_92).getViewState());
    expect(state.style).toBe('play-along');
    expect(state.countInBars).toBe(1);
  });

  it("reads the written tempo, beat unit and meter from the file; nothing is 'changed' yet", () => {
    expect(tempoOf(importFor(TUNE_92))).toMatchObject({
      bpm: 92,
      writtenBpm: 92,
      differs: false,
      unitSymbol: '♩',
      writtenText: '♩ = 92',
      currentText: '♩ = 92',
      percentText: '100% of the written tempo',
      hints: ['100% of the written tempo'],
      source: 'file',
      countInBeats: 4,
      minBpm: MIN_TEMPO_BPM,
      maxBpm: MAX_TEMPO_BPM,
    });
  });

  it("uses the meter's own beat for the unit: a dotted quarter in 6/8", () => {
    const tempo = tempoOf(importFor('X:1\nM:6/8\nL:1/8\nQ:3/8=60\nK:C\nC D E F G A|\n'));
    expect(tempo).toMatchObject({ bpm: 60, unitSymbol: '♩.', writtenText: '♩. = 60' });
    expect(tempo.countInBeats).toBe(2);
  });

  it('says so when the file has no tempo and no time signature, and starts gently', () => {
    const tempo = tempoOf(importFor(TUNE_BARE));
    expect(tempo).toMatchObject({ bpm: 80, source: 'default', writtenText: '♩ = 80' });
    // The wording is core's (`describeTempoSettings`), identical on desktop.
    expect(tempo.hints).toEqual([
      '100% of the default tempo',
      '(This file has no tempo marking; starting at ♩ = 80.)',
      '(No time signature in this file; assuming 4/4.)',
    ]);
  });

  it("gives a default tempo in the meter's own beat (6/8 counts dotted quarters)", () => {
    const tempo = tempoOf(importFor('X:1\nM:6/8\nL:1/8\nK:C\nC D E F G A|\n'));
    expect(tempo).toMatchObject({ source: 'default', unitSymbol: '♩.', bpm: 53 });
  });

  it('has no tempo settings until something practicable is selected', () => {
    expect(importState(new AbcPracticeController(noPicker).getViewState()).tempo).toBeUndefined();
    const tooLow = importFor('X:1\nK:C\nC, D, E,\n');
    expect(importState(tooLow.getViewState()).tempo).toBeUndefined();
    tooLow.setTranspose(12);
    expect(tempoOf(tooLow).bpm).toBe(80);
  });

  it('switches style and count-in', () => {
    const controller = importFor(TUNE_92);
    controller.setStyle('wait');
    controller.setCountIn(2);
    expect(importState(controller.getViewState())).toMatchObject({
      style: 'wait',
      countInBars: 2,
    });
    expect(tempoOf(controller).countInBeats).toBe(8);
    controller.setCountIn(0);
    expect(tempoOf(controller).countInBeats).toBe(0);
  });

  it('counts a pickup\'s own beats off the count-in ("1 2 3", then the pickup on 4)', () => {
    const controller = importFor('X:1\nM:4/4\nL:1/4\nQ:1/4=92\nK:C\nG|c d e f|g\n');
    expect(tempoOf(controller).countInBeats).toBe(3);
    controller.setCountIn(2);
    expect(tempoOf(controller).countInBeats).toBe(7);
  });
});

describe('AbcPracticeController: editing the tempo without touching the file', () => {
  it('changes the tempo and reports it as a percentage of the written one', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(46);
    expect(tempoOf(controller)).toMatchObject({
      bpm: 46,
      writtenBpm: 92,
      differs: true,
      percentText: '50% of the written tempo',
      currentText: '♩ = 46',
      writtenText: '♩ = 92',
    });
    controller.setTempo(115);
    expect(tempoOf(controller)).toMatchObject({
      bpm: 115,
      percentText: '125% of the written tempo',
      differs: true,
    });
  });

  it("shows exactly what core's describeTempoSettings says (no local wording or clamping)", () => {
    const controller = importFor(TUNE_BARE, (c) => c.setTempo(70));
    const tune = parseAbc(TUNE_BARE).tunes[0]!;
    const built = buildAbcPracticeSequence(tune);
    if (built.status !== 'ok') throw new Error('fixture must be practicable');
    expect(importState(controller.getViewState()).tempo?.settings).toEqual(
      describeTempoSettings(built.piece, 70),
    );
  });

  it('rounds to a whole number and clamps to 20..300', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(100.4);
    expect(tempoOf(controller).bpm).toBe(100);
    controller.setTempo(5);
    expect(tempoOf(controller).bpm).toBe(20);
    controller.setTempo(1000);
    expect(tempoOf(controller).bpm).toBe(300);
    controller.setTempo(-40);
    expect(tempoOf(controller).bpm).toBe(20);
  });

  it('ignores a number that is not a number', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(60);
    controller.setTempo(Number.NaN);
    controller.setTempo(Number.POSITIVE_INFINITY);
    expect(tempoOf(controller).bpm).toBe(60);
  });

  it('resets to the written tempo, and setting the written value is not a change', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(60);
    controller.resetTempo();
    expect(tempoOf(controller)).toMatchObject({
      bpm: 92,
      differs: false,
      percentText: '100% of the written tempo',
    });
    controller.setTempo(92);
    expect(tempoOf(controller)).toMatchObject({ bpm: 92, differs: false });
  });

  it('keeps a tempo outside the allowed range usable: the default is the nearest allowed one, and not a "change"', () => {
    const tempo = tempoOf(importFor('X:1\nM:4/4\nL:1/4\nQ:1/4=400\nK:C\nC D E F|\n'));
    expect(tempo).toMatchObject({
      bpm: 300,
      writtenBpm: 300,
      differs: false,
      writtenText: '♩ = 300',
    });
  });

  it('pushes tempo changes through onChange', () => {
    const states: AbcPracticeViewState[] = [];
    const controller = new AbcPracticeController(noPicker, { onChange: (s) => states.push(s) });
    controller.loadText('t.abc', TUNE_92);
    const before = states.length;
    controller.setTempo(70);
    expect(states.length).toBe(before + 1);
    expect(importState(states.at(-1)!).tempo?.settings.bpm).toBe(70);
  });

  it('goes back to the written tempo when the file, the tune or the transposition changes', () => {
    const controller = importFor(
      `${TUNE_92}\nX:2\nT:Other\nM:4/4\nL:1/4\nQ:1/4=60\nK:C\nE F G A|\n`,
    );
    controller.setTempo(50);
    controller.selectTune(1);
    expect(tempoOf(controller)).toMatchObject({ bpm: 60, differs: false });

    controller.setTempo(50);
    controller.setTranspose(12);
    expect(tempoOf(controller)).toMatchObject({ bpm: 60, differs: false });

    controller.setTempo(50);
    controller.loadText('next.abc', TUNE_92);
    expect(tempoOf(controller)).toMatchObject({ bpm: 92, differs: false });
  });

  it('keeps the edited tempo when the same tune or transposition is chosen again, and across style / count-in changes', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(50);
    controller.selectTune(0);
    controller.setTranspose(0);
    controller.setStyle('wait');
    controller.setStyle('play-along');
    controller.setCountIn(2);
    expect(tempoOf(controller).bpm).toBe(50);
  });

  it('never writes anything back: the file name and text are only ever read', () => {
    const controller = importFor(TUNE_92);
    controller.setTempo(40);
    expect(importState(controller.getViewState()).fileName).toBe('t.abc');
    // The summary still describes the file as written (the "4/4" and the notes), not the edited tempo.
    expect(importState(controller.getViewState()).summaryText).toContain('Four');
  });
});

// ---------------------------------------------------------------------------------
// A timed play-along driven by synthetic detector frames
// ---------------------------------------------------------------------------------

/** The real analysis hop (512 samples at 44.1 kHz). */
const HOP_MS = 11.6;
/** How far a perfect player's detector output trails the printed onset (the session's default allowance). */
const DETECTION_LAG_MS = 60;

interface Performance {
  /** Note indices that are never played. */
  readonly skip?: readonly number[];
  /** Note index -> semitones to play it off by. */
  readonly semitones?: Readonly<Record<number, number>>;
}

/** What the detector reports at plan time `tMs` for a player performing `plan` with the given mistakes. */
function readingAtPlanTime(plan: PlayAlongPlan, tMs: number, perf: Performance = {}): PitchReading {
  for (const note of plan.notes) {
    if (perf.skip?.includes(note.index)) continue;
    const from = note.onsetMs + DETECTION_LAG_MS;
    const to = note.endMs + DETECTION_LAG_MS - 20; // a little articulation gap before the next note
    if (tMs >= from && tMs < to) {
      return voiced(midiToFrequencyHz(note.midi + (perf.semitones?.[note.index] ?? 0)));
    }
  }
  return unvoiced;
}

/** Starts a play-along over `abc` on a hand-driven clock. */
function playAlongHarness(abc: string, tweak?: (c: AbcPracticeController) => void) {
  const clock = { now: 50_000 };
  const changes: AbcPracticeViewState[] = [];
  const controller = new AbcPracticeController(
    noPicker,
    { onChange: (s) => changes.push(s) },
    { nowMs: () => clock.now },
  );
  controller.loadText('t.abc', abc);
  tweak?.(controller);
  controller.start();
  const state = controller.getViewState();
  if (state.phase !== 'play-along') throw new Error(`expected a play-along, got ${state.phase}`);
  const changesAtStart = changes.length;
  const plan = buildPlayAlongPlan(state.run.piece, {
    tempoBpm: state.run.tempoBpm,
    countInBeats: state.run.countInBeats,
  });
  const zeroMs = clock.now - controller.getPlayAlongView()!.timeMs;

  /** Feeds frames for plan times `fromMs..toMs`, moving the clock with them. */
  const feed = (fromMs: number, toMs: number, perf: Performance = {}): void => {
    for (let t = fromMs; t <= toMs; t += HOP_MS) {
      clock.now = zeroMs + t;
      const reading = readingAtPlanTime(plan, t, perf);
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), clock.now);
    }
  };
  /** The whole run, count-in included, until the piece is over. */
  const playAll = (perf: Performance = {}): void => {
    feed(-plan.countInMs - DEFAULT_PLAY_ALONG_LEAD_MS, plan.totalMs + 2000, perf);
  };
  const at = (planMs: number) => {
    clock.now = zeroMs + planMs;
    return controller.getPlayAlongView()!;
  };
  return { controller, clock, changes, changesAtStart, plan, zeroMs, feed, playAll, at };
}

describe('AbcPracticeController: starting a play-along', () => {
  it('moves to the play-along phase at the chosen tempo and count-in, with a count-in under way', () => {
    const h = playAlongHarness(TUNE_92, (c) => {
      c.setTempo(60);
      c.setCountIn(2);
    });
    const state = h.controller.getViewState();
    expect(state).toMatchObject({
      phase: 'play-along',
      run: { runId: 1, tempoBpm: 60, countInBeats: 8 },
    });
    const view = h.controller.getPlayAlongView()!;
    expect(view.phase).toBe('count-in');
    expect(view.tempoText).toBe('♩ = 60');
    expect(view.countInRemaining).toBe(8);
    expect(h.plan.tempoBpm).toBe(60);
  });

  it('plays at the written tempo when it was not edited', () => {
    const h = playAlongHarness(TUNE_92);
    expect(h.controller.getPlayAlongView()!.tempoText).toBe('♩ = 92');
    expect(h.plan.notes[1]!.onsetMs - h.plan.notes[0]!.onsetMs).toBeCloseTo(60000 / 92, 6);
  });

  it('counts in and then plays, on the platform clock alone', () => {
    const h = playAlongHarness(TUNE_92);
    expect(h.at(-4 * 652).countInRemaining).toBe(4);
    expect(h.at(-4 * 652).beat).toMatchObject({ inBar: 1, accent: true });
    expect(h.at(-1 * 652 + 10).countInRemaining).toBe(1);
    const playing = h.at(20);
    expect(playing.phase).toBe('playing');
    expect(playing.progressText).toBe('Bar 1 of 2');
    expect(h.at(5 * 652).progressText).toBe('Bar 2 of 2');
  });

  it('plays an untouched tempo exactly as written, even a fractional one, and the clamped one when it is out of range', () => {
    const exact = playAlongHarness('X:1\nM:4/4\nL:1/4\nQ:1/4=92.5\nK:C\nC D E F|\n');
    expect(exact.controller.getViewState()).toMatchObject({ run: { tempoBpm: 92.5 } });

    const fast = playAlongHarness('X:1\nM:4/4\nL:1/4\nQ:1/4=400\nK:C\nC D E F|\n');
    expect(fast.controller.getViewState()).toMatchObject({ run: { tempoBpm: 300 } });

    // Once the user sets a tempo, that whole number is used.
    const edited = playAlongHarness('X:1\nM:4/4\nL:1/4\nQ:1/4=92.5\nK:C\nC D E F|\n', (c) =>
      c.setTempo(93),
    );
    expect(edited.controller.getViewState()).toMatchObject({ run: { tempoBpm: 93 } });
  });

  it('has no view without a run', () => {
    expect(importFor(TUNE_92).getPlayAlongView()).toBeUndefined();
  });

  it('start() is refused when nothing practicable is selected, in this style too', () => {
    const controller = importFor('X:1\nK:C\nC, D, E,\n');
    controller.start();
    expect(controller.getViewState().phase).toBe('import');
    expect(controller.getPlayAlongView()).toBeUndefined();
  });

  it('reports a piece the play-along plan cannot be built for instead of throwing', () => {
    // 13,000 whole-note bars of 4/4: more metronome beats (52,000) than a plan allows (50,000).
    const controller = importFor(`X:1\nM:4/4\nL:1/4\nK:C\n${'C4|'.repeat(13_000)}\n`);
    expect(importState(controller.getViewState()).canStart).toBe(true);
    controller.start();
    const state = importState(controller.getViewState());
    expect(state.error).toContain('cannot be played along');
    // The untimed style still works for it.
    controller.setStyle('wait');
    expect(importState(controller.getViewState()).error).toBeUndefined();
    controller.start();
    expect(controller.getViewState().phase).toBe('session');
  });
});

describe('AbcPracticeController: a play-along run', () => {
  it('judges every note of a perfect run on time and finishes by itself', () => {
    const h = playAlongHarness(TUNE_92);
    h.playAll();
    const view = h.controller.getPlayAlongView()!;
    expect(view.phase).toBe('finished');
    expect(view.noteStates).toEqual(Array(8).fill('hit'));
    expect(view.summary).toMatchObject({
      headline: '8 of 8 notes on time (100%)',
      hits: 8,
      total: 8,
      complete: true,
      missedNoteIndices: [],
    });
    // Still the play-along phase: the results card is drawn from the polled view.
    expect(h.controller.getViewState().phase).toBe('play-along');
  });

  it('never pushes a view state per frame: only user actions reach onChange', () => {
    const h = playAlongHarness(TUNE_92);
    // Starting the run pushed exactly one state (after the one that loaded the file)...
    expect(h.changesAtStart).toBe(2);
    expect(h.changes.at(-1)?.phase).toBe('play-along');
    // ...and a whole run's worth of frames, the finish included, pushed none.
    h.playAll();
    expect(h.controller.getPlayAlongView()!.phase).toBe('finished');
    expect(h.changes.length).toBe(h.changesAtStart);
  });

  it('lists the missed notes with where they are and what went wrong', () => {
    const h = playAlongHarness(TUNE_92);
    h.playAll({ skip: [2], semitones: { 5: -3 } });
    const summary = h.controller.getPlayAlongView()!.summary!;
    expect(summary.headline).toBe('6 of 8 notes on time (75%)');
    expect(summary.missedNoteIndices).toEqual([2, 5]);
    expect(summary.misses).toEqual([
      { noteIndex: 2, text: 'Bar 1, beat 3 · E4 — not played' },
      { noteIndex: 5, text: 'Bar 2, beat 2 · A4 — played the wrong note' },
    ]);
    expect(h.controller.getPlayAlongView()!.noteStates).toEqual([
      'hit',
      'hit',
      'missed',
      'hit',
      'hit',
      'missed',
      'hit',
      'hit',
    ]);
  });

  it('shows the live note states and feedback while it runs, flat-aware', () => {
    const h = playAlongHarness(TUNE_F);
    // Mid-way through the B-flat (the 4th note), played correctly.
    h.feed(-h.plan.countInMs - DEFAULT_PLAY_ALONG_LEAD_MS, h.plan.notes[3]!.onsetMs + 300);
    const view = h.controller.getPlayAlongView()!;
    expect(view.noteStates.slice(0, 3)).toEqual(['hit', 'hit', 'hit']);
    expect(view.targetLabel).toBe('B♭4');
    expect(view.liveFeedbackText).toMatch(/^Hearing B♭4 \(/);
  });

  it('turns on signalLost when no frames arrive', () => {
    const h = playAlongHarness(TUNE_92);
    expect(h.at(-3000).signalLost).toBe(false); // 0.2 s after Start
    expect(h.at(2000).signalLost).toBe(true);
  });

  it('forwards frames to the run, not to a Wait-for-me session', () => {
    const h = playAlongHarness(TUNE_92);
    const reading = voiced(midiToFrequencyHz(60));
    h.clock.now = h.zeroMs - 3000;
    h.controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), h.clock.now);
    expect(h.controller.getPlayAlongView()!.liveFeedbackText).toMatch(/^Hearing C4/);
    expect(h.controller.getViewState().phase).toBe('play-along');
  });
});

describe('AbcPracticeController: stopping, playing again, changing settings', () => {
  it('Stop mid-piece ends the run and keeps the results of the notes judged so far', () => {
    const h = playAlongHarness(TUNE_92);
    h.feed(-h.plan.countInMs - DEFAULT_PLAY_ALONG_LEAD_MS, h.plan.notes[3]!.onsetMs + 500);
    h.controller.stopPlayAlong();
    const view = h.controller.getPlayAlongView()!;
    expect(view.phase).toBe('finished');
    expect(view.summary?.complete).toBe(false);
    expect(view.summary?.headline).toMatch(/^4 of 8 notes on time \(50%\) · 4 not reached$/);
    expect(h.controller.getViewState().phase).toBe('play-along');
    // Frames after the stop change nothing.
    const before = view.noteStates;
    h.feed(h.plan.notes[4]!.onsetMs, h.plan.totalMs);
    expect(h.controller.getPlayAlongView()!.noteStates).toBe(before);
  });

  it('Stop before anything was judged goes straight back to the settings', () => {
    const h = playAlongHarness(TUNE_92, (c) => c.setTempo(70));
    h.feed(-h.plan.countInMs - DEFAULT_PLAY_ALONG_LEAD_MS, -1000);
    h.controller.stopPlayAlong();
    expect(importState(h.controller.getViewState()).tempo?.settings.bpm).toBe(70);
    expect(h.controller.getPlayAlongView()).toBeUndefined();
  });

  it('Play again starts a fresh run with the same piece, tempo and count-in', () => {
    const h = playAlongHarness(TUNE_92, (c) => {
      c.setTempo(80);
      c.setCountIn(2);
    });
    h.playAll({ skip: [1] });
    expect(h.controller.getPlayAlongView()!.phase).toBe('finished');
    h.clock.now += 10_000;
    h.controller.playAgain();
    const state = h.controller.getViewState();
    expect(state).toMatchObject({
      phase: 'play-along',
      run: { runId: 2, tempoBpm: 80, countInBeats: 8 },
    });
    const view = h.controller.getPlayAlongView()!;
    expect(view.phase).toBe('count-in');
    expect(view.noteStates).toEqual(Array(8).fill('pending'));
    expect(view.summary).toBeUndefined();
  });

  it('Change settings returns to the import screen with the file, tune and edited tempo intact', () => {
    const h = playAlongHarness(TUNE_92, (c) => c.setTempo(70));
    h.playAll();
    h.controller.changeSettings();
    expect(h.controller.getPlayAlongView()).toBeUndefined();
    expect(importState(h.controller.getViewState())).toMatchObject({
      fileName: 't.abc',
      canStart: true,
      tempo: { settings: { bpm: 70, differs: true } },
    });
  });

  it('Practice missed notes starts a Wait-for-me session over just those notes', () => {
    const h = playAlongHarness(TUNE_F, (c) => c.setTempo(60));
    h.playAll({ skip: [3], semitones: { 6: 1 } });
    expect(h.controller.getPlayAlongView()!.summary?.missedNoteIndices).toEqual([3, 6]);
    h.controller.practiceMissedNotes();

    const state = h.controller.getViewState();
    if (state.phase !== 'session') throw new Error('expected a session');
    expect(state.missedNotesOnly).toBe(true);
    const session = activeSession(state);
    // Spelled as the sheet spells them (B-flat, not A-sharp), with no score window: they are not the piece in order.
    expect(session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'B♭4',
      progressText: 'Note 1 of 2',
      upcomingText: 'Next: E5',
    });
    expect(session.score).toBeUndefined();
    expect(h.controller.getPlayAlongView()).toBeUndefined();
  });

  it('practices the missed notes one by one, ends on a screen that offers to play along again', () => {
    const h = playAlongHarness(TUNE_F);
    h.playAll({ skip: [3] });
    h.controller.practiceMissedNotes();
    const play = makePlayer(h.controller);
    play(voiced(midiToFrequencyHz(70)), 300); // B-flat 4
    expect(h.controller.getViewState()).toMatchObject({
      phase: 'session',
      session: { kind: 'complete' },
      missedNotesOnly: true,
    });
    h.clock.now += 5000;
    h.controller.playAgain();
    expect(h.controller.getViewState()).toMatchObject({ phase: 'play-along', run: { runId: 2 } });
  });

  it('Practice missed notes does nothing when nothing was missed', () => {
    const h = playAlongHarness(TUNE_92);
    h.playAll();
    h.controller.practiceMissedNotes();
    expect(h.controller.getViewState().phase).toBe('play-along');
  });

  it('Practice missed notes does nothing while the run is still going', () => {
    const h = playAlongHarness(TUNE_92);
    h.controller.practiceMissedNotes();
    expect(h.controller.getViewState().phase).toBe('play-along');
  });

  it('Play again and Stop are no-ops with no run', () => {
    const controller = importFor(TUNE_92);
    controller.playAgain();
    controller.stopPlayAlong();
    controller.practiceMissedNotes();
    expect(controller.getViewState().phase).toBe('import');
  });
});

describe('AbcPracticeController: the two styles do not leak into each other', () => {
  it('a finished play-along does not leak into a later Wait-for-me session', () => {
    const h = playAlongHarness(TUNE_92);
    h.playAll({ skip: [0] });
    h.controller.changeSettings();
    h.controller.setStyle('wait');
    h.controller.start();

    const state = h.controller.getViewState();
    if (state.phase !== 'session') throw new Error('expected a session');
    expect(state.missedNotesOnly).toBeUndefined();
    expect(activeSession(state)).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'C4',
      progressText: 'Note 1 of 8',
    });
    expect(h.controller.getPlayAlongView()).toBeUndefined();
  });

  it('frames drive the Wait-for-me session in that style, and there is no run to receive them', () => {
    const controller = importFor(TUNE_92, (c) => c.setStyle('wait'));
    controller.start();
    const play = makePlayer(controller);
    play(voiced(midiToFrequencyHz(60)), 300);
    expect(activeSession(controller.getViewState()).banner?.text).toBe('Nice!');
    expect(controller.getPlayAlongView()).toBeUndefined();
  });

  it('starting a play-along discards a Wait-for-me session that was left running', () => {
    const controller = importFor(TUNE_92, (c) => c.setStyle('wait'));
    controller.start();
    expect(controller.getViewState().phase).toBe('session');
    controller.restart();
    controller.setStyle('play-along');
    controller.start();
    expect(controller.getViewState().phase).toBe('play-along');
  });

  it('restart() from a play-along returns to the import screen and drops the run', () => {
    const h = playAlongHarness(TUNE_92);
    h.controller.restart();
    expect(h.controller.getViewState().phase).toBe('import');
    expect(h.controller.getPlayAlongView()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------
// Wait for me with real notation: flat/sharp spelling and the score window
// ---------------------------------------------------------------------------------

describe('AbcPracticeController: Wait for me spells notes the way the sheet does', () => {
  function waitSession(abc: string) {
    const controller = importFor(abc, (c) => c.setStyle('wait'));
    controller.start();
    return controller;
  }

  it('shows flats in the target, the "Next:" line and the "Hearing ..." line', () => {
    const controller = waitSession('X:1\nM:4/4\nL:1/4\nK:F\nB c d e|\n');
    const session = activeSession(controller.getViewState());
    expect(session.targetNoteLabel).toBe('B♭4');
    expect(session.upcomingText).toBe('Next: C5 D5 E5');

    const play = makePlayer(controller);
    play(voiced(midiToFrequencyHz(70)), 40); // a B-flat: the target
    expect(activeSession(controller.getViewState()).liveFeedbackText).toMatch(/^Hearing B♭4 \(/);
    play(voiced(midiToFrequencyHz(73)), 40); // a chromatic note in a flat key is spelled with flats
    expect(activeSession(controller.getViewState()).liveFeedbackText).toMatch(/^Hearing D♭5 \(/);
  });

  it('shows sharps in a sharp key', () => {
    const controller = waitSession('X:1\nM:4/4\nL:1/4\nK:G\nF G A B|\n');
    expect(activeSession(controller.getViewState()).targetNoteLabel).toBe('F♯4');
    const play = makePlayer(controller);
    play(voiced(midiToFrequencyHz(66)), 40);
    expect(activeSession(controller.getViewState()).liveFeedbackText).toMatch(/^Hearing F♯4 \(/);
  });

  it("hands the Staff display the piece and the target's index, following Drilling", () => {
    const controller = waitSession('X:1\nM:4/4\nL:1/4\nK:C\nC D E F|\n');
    let session = activeSession(controller.getViewState());
    expect(session.score).toMatchObject({ targetIndex: 0 });
    expect(session.score?.piece.notes).toHaveLength(4);

    controller.giveUp(); // drill the first note
    const play = makePlayer(controller);
    play(voiced(midiToFrequencyHz(60)), 300); // a correct drill rep rotates to the neighbor
    session = activeSession(controller.getViewState());
    expect(session.mode).toBe('drilling');
    expect(session.score?.targetIndex).toBe(1);
  });

  it('moves the score target on after a note succeeds, but keeps the note just played during the "Nice!" banner', () => {
    const controller = waitSession('X:1\nM:4/4\nL:1/4\nK:C\nC D E F|\n');
    const play = makePlayer(controller);
    play(voiced(midiToFrequencyHz(60)), 300);
    expect(activeSession(controller.getViewState())).toMatchObject({
      banner: { text: 'Nice!' },
      score: { targetIndex: 0 },
    });
    play(unvoiced, 800);
    expect(activeSession(controller.getViewState()).score?.targetIndex).toBe(1);
  });

  it('a Wait-for-me session over the piece in order always carries the score', () => {
    const controller = waitSession('X:1\nM:4/4\nL:1/4\nK:C\nC D E F|\n');
    expect(activeSession(controller.getViewState()).score).toBeDefined();
  });
});

describe('AbcPracticeController: finger numbers', () => {
  // The file writes a finger for A3 only; B3, C4 and D4 are unmarked.
  const FINGERED = 'X:1\nM:4/4\nL:1/4\nQ:1/4=80\nK:C\n!2!A, B, C D |]\n';

  it('are shown by default and can be switched off on the import screen', () => {
    const controller = new AbcPracticeController(noPicker);
    expect(importState(controller.getViewState()).showFingers).toBe(true);
    controller.setFingers(false);
    expect(importState(controller.getViewState()).showFingers).toBe(false);
  });

  it('Wait for me: the target has the file`s finger, and the score gets only the file`s marks', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', FINGERED);
    controller.setStyle('wait');
    controller.start();
    const session = activeSession(controller.getViewState());
    expect(session.finger).toEqual({ text: 'Finger 2' });
    expect(session.score?.fingers?.[0]).toEqual({ finger: 2 });
    expect(session.score?.fingers?.[1]).toBeUndefined(); // B3
    expect(session.score?.fingers?.[3]).toBeUndefined(); // D4, an open-string pitch
  });

  it('says "Open string" for a written !0!', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', 'X:1\nK:C\n!0!D C\n');
    controller.setStyle('wait');
    controller.start();
    expect(activeSession(controller.getViewState()).finger).toEqual({ text: 'Open string' });
  });

  it('shows nothing when switched off, and nothing for a note the file leaves unmarked', () => {
    const off = new AbcPracticeController(noPicker);
    off.loadText('t.abc', FINGERED);
    off.setStyle('wait');
    off.setFingers(false);
    off.start();
    const session = activeSession(off.getViewState());
    expect(session.finger).toBeUndefined();
    expect(session.score?.fingers).toBeUndefined();

    const unmarked = new AbcPracticeController(noPicker);
    unmarked.loadText('t.abc', 'X:1\nK:C\nD\n');
    unmarked.setStyle('wait');
    unmarked.start();
    expect(activeSession(unmarked.getViewState()).finger).toBeUndefined();
  });

  it('follows the target through the piece', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', 'X:1\nM:4/4\nL:1/4\nQ:1/4=80\nK:C\n!2!A, !4!B, C D |]\n');
    controller.setStyle('wait');
    controller.start();
    const play = makePlayer(controller);
    play(voiced(HZ.A3), 400);
    play(unvoiced, 700); // past the success banner
    play(voiced(HZ.B3), 20);
    const session = activeSession(controller.getViewState());
    expect(session.targetNoteLabel).toBe('B3');
    expect(session.finger).toEqual({ text: 'Finger 4' });
  });

  it('are carried by the play-along run, or absent when off', () => {
    const on = playAlongHarness(FINGERED);
    const run = (
      on.controller.getViewState() as Extract<AbcPracticeViewState, { phase: 'play-along' }>
    ).run;
    expect(run.fingers?.[0]).toEqual({ finger: 2 });
    expect(on.controller.getPlayAlongView()!.targetNoteIndex).toBe(0);

    const off = playAlongHarness(FINGERED, (c) => c.setFingers(false));
    const offRun = (
      off.controller.getViewState() as Extract<AbcPracticeViewState, { phase: 'play-along' }>
    ).run;
    expect(offRun.fingers).toBeUndefined();
  });

  it('are dropped for a transposed piece (the file wrote them for the sheet`s own strings)', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', 'X:1\nK:C\n!4!A, B,\n');
    controller.setStyle('wait');
    controller.setTranspose(12);
    controller.start();
    expect(activeSession(controller.getViewState()).finger).toBeUndefined();
  });
});

describe('AbcPracticeController: finger numbers switch live', () => {
  const FINGERED = 'X:1\nM:4/4\nL:1/4\nQ:1/4=80\nK:C\n!2!A, B, C D |]\n';

  it('mid-session, Wait for me drops and restores the finger line and the score digits', () => {
    const controller = new AbcPracticeController(noPicker);
    controller.loadText('t.abc', FINGERED);
    controller.setStyle('wait');
    controller.start();
    expect(activeSession(controller.getViewState()).finger).toBeDefined();

    controller.setFingers(false);
    let session = activeSession(controller.getViewState());
    expect(session.finger).toBeUndefined();
    expect(session.score?.fingers).toBeUndefined();
    expect(session.targetNoteLabel).toBe('A3'); // the attempt in progress is untouched

    controller.setFingers(true);
    session = activeSession(controller.getViewState());
    expect(session.finger).toEqual({ text: 'Finger 2' });
    expect(session.score?.fingers?.[0]).toEqual({ finger: 2 });
  });

  it('mid-run, the play-along keeps its run and swaps the marks', () => {
    const h = playAlongHarness(FINGERED);
    const runOf = () =>
      (h.controller.getViewState() as Extract<AbcPracticeViewState, { phase: 'play-along' }>).run;
    const runId = runOf().runId;
    expect(runOf().fingers).toBeDefined();
    h.controller.setFingers(false);
    expect(runOf().fingers).toBeUndefined();
    expect(runOf().runId).toBe(runId);
    h.controller.setFingers(true);
    expect(runOf().fingers?.[0]).toEqual({ finger: 2 });
  });
});
