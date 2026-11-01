import { describe, expect, it } from 'vitest';
import {
  analyzeTunerReading,
  generatePlayingPracticeSequence,
  type PitchReading,
} from '@violin/core';
import {
  INITIAL_PLAYING_PRACTICE_VIEW_STATE,
  PlayingPracticeController,
  type PlayingPracticeViewState,
} from './playing-practice-controller';

const voiced = (frequencyHz: number, confidence = 0.9): PitchReading => ({
  voiced: true,
  frequencyHz,
  confidence,
});
const unvoiced: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

function expectConfig(
  state: PlayingPracticeViewState,
): asserts state is Extract<PlayingPracticeViewState, { phase: 'config' }> {
  expect(state.phase).toBe('config');
}
function expectActiveSession(state: PlayingPracticeViewState): asserts state is {
  phase: 'session';
  session: Extract<
    Extract<PlayingPracticeViewState, { phase: 'session' }>['session'],
    { kind: 'active' }
  >;
} {
  expect(state.phase).toBe('session');
  if (state.phase === 'session') {
    expect(state.session.kind).toBe('active');
  }
}

/** Only `G` selected, `open-strings` pattern -- always exactly 1 note (G3). */
function startSingleNoteSession(): PlayingPracticeController {
  const controller = new PlayingPracticeController();
  controller.setStringSelected('D', false);
  controller.setStringSelected('A', false);
  controller.setStringSelected('E', false);
  controller.setPatternType('open-strings');
  controller.start();
  return controller;
}

describe('PlayingPracticeController: initial state', () => {
  it('starts in the config phase with all four strings selected, the default pattern/direction, and a non-empty preview', () => {
    const controller = new PlayingPracticeController();
    const state = controller.getViewState();
    expectConfig(state);
    expect(state.config).toEqual({
      strings: { G: true, D: true, A: true, E: true },
      patternType: 'stepwise-first-position',
      direction: 'ascending',
      minFrequencyText: '150',
      maxFrequencyText: '3000',
    });
    expect(state.preview.kind).toBe('ok');
    expect(state.configError).toBeUndefined();
  });

  it("INITIAL_PLAYING_PRACTICE_VIEW_STATE (App.tsx's useState initializer) matches a fresh controller instance", () => {
    expect(INITIAL_PLAYING_PRACTICE_VIEW_STATE).toEqual(
      new PlayingPracticeController().getViewState(),
    );
  });

  it('getViewState() never invokes onChange -- only explicit mutators do', () => {
    let calls = 0;
    const controller = new PlayingPracticeController({ onChange: () => (calls += 1) });
    controller.getViewState();
    controller.getViewState();
    expect(calls).toBe(0);
  });
});

describe('PlayingPracticeController: config mutators + live preview', () => {
  it('toggling a string off updates the config snapshot and preview, and notifies onChange', () => {
    let latest: PlayingPracticeViewState | undefined;
    const controller = new PlayingPracticeController({ onChange: (s) => (latest = s) });

    controller.setStringSelected('G', false);

    expect(latest).toBeDefined();
    expectConfig(latest!);
    expect(latest!.config.strings).toEqual({ G: false, D: true, A: true, E: true });
    expect(latest!.preview.kind).toBe('ok');
  });

  it('deselecting every string reports a structural RangeError as an error preview, not a thrown exception', () => {
    const controller = new PlayingPracticeController();
    controller.setStringSelected('G', false);
    controller.setStringSelected('D', false);
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.preview.kind).toBe('error');
  });

  it('an inverted min/max frequency range reports an error preview', () => {
    const controller = new PlayingPracticeController();
    controller.setMinFrequencyText('2000');
    controller.setMaxFrequencyText('100');

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.preview.kind).toBe('error');
  });

  it('a valid-but-unproductive range reports an empty preview, not an error', () => {
    const controller = new PlayingPracticeController();
    controller.setMinFrequencyText('5000');
    controller.setMaxFrequencyText('6000');

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.preview).toEqual({
      kind: 'empty',
      text: '0 notes — this configuration produces an empty sequence.',
    });
  });

  it('a non-numeric frequency field resolves to an empty preview rather than throwing (Number(garbage) is NaN, never plausibly in range)', () => {
    const controller = new PlayingPracticeController();
    controller.setMinFrequencyText('abc');
    const state = controller.getViewState();
    expectConfig(state);
    expect(state.preview.kind).toBe('empty');
  });

  it('changing pattern type visibly changes the preview note count for the same single string', () => {
    const controller = new PlayingPracticeController();
    controller.setStringSelected('D', false);
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false); // G only
    controller.setPatternType('open-strings');

    let state = controller.getViewState();
    expectConfig(state);
    expect(state.preview).toEqual({ kind: 'ok', text: '1 note: G3' });

    controller.setPatternType('one-octave-scale');
    state = controller.getViewState();
    expectConfig(state);
    expect(state.preview.kind).toBe('ok');
    expect((state.preview as { text: string }).text.startsWith('8 notes:')).toBe(true);
  });
});

describe('PlayingPracticeController: start()', () => {
  it('a structurally invalid config sets configError and stays on the config phase', () => {
    const controller = new PlayingPracticeController();
    controller.setStringSelected('G', false);
    controller.setStringSelected('D', false);
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);

    controller.start();

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.configError).toBeDefined();
  });

  it('a valid-but-empty config sets a friendly configError and stays on the config phase', () => {
    const controller = new PlayingPracticeController();
    controller.setMinFrequencyText('5000');
    controller.setMaxFrequencyText('6000');

    controller.start();

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.configError).toMatch(/no notes to practice/);
  });

  it('a valid config transitions to the session phase, active playing-practice mode, on note 1', () => {
    const controller = startSingleNoteSession();

    const state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      kind: 'active',
      mode: 'playing-practice',
      progressText: 'Note 1 of 1',
      targetNoteLabel: 'G3',
      liveFeedbackText: '',
      dwellFraction: 0,
      showGiveUpButton: true,
      showSkipDrillButton: false,
      banner: undefined,
    });
  });
});

describe('PlayingPracticeController: handleAnalysisFrame()/giveUp() before start()', () => {
  it('handleAnalysisFrame() is a no-op before a session has started', () => {
    const controller = new PlayingPracticeController();
    const reading = voiced(440);
    expect(() =>
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), 0),
    ).not.toThrow();
    expect(controller.getViewState().phase).toBe('config');
  });

  it('giveUp() is a no-op before a session has started', () => {
    const controller = new PlayingPracticeController();
    expect(() => controller.giveUp()).not.toThrow();
    expect(controller.getViewState().phase).toBe('config');
  });
});

describe('PlayingPracticeController: live feedback text', () => {
  it('shows "No signal" for an unvoiced frame and "Unclear signal…" for a low-confidence one', () => {
    const controller = startSingleNoteSession();

    controller.handleAnalysisFrame(unvoiced, analyzeTunerReading(unvoiced), 0);
    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ liveFeedbackText: 'No signal' });

    const lowConfidence = voiced(196, 0.1);
    controller.handleAnalysisFrame(lowConfidence, analyzeTunerReading(lowConfidence), 20);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ liveFeedbackText: 'Unclear signal…' });
  });

  it('shows a signed-cents "Hearing <note> (<+/-Nc> from target)" line for a trustworthy reading', () => {
    const controller = startSingleNoteSession();
    // G3's target frequency is 196.00Hz; a semitone-ish sharp reading should
    // report a large positive offset.
    const sharp = voiced(196 * 2 ** (30 / 1200));
    controller.handleAnalysisFrame(sharp, analyzeTunerReading(sharp), 0);
    const state = controller.getViewState();
    expectActiveSession(state);
    expect((state.session as { liveFeedbackText: string }).liveFeedbackText).toMatch(
      /^Hearing G3 \(\+30c from target\)$/,
    );
  });
});

describe('PlayingPracticeController: stays sharps-only and score-less (ABC practice does not change it)', () => {
  it('spells what it hears with sharps, shows letter names, and carries no ABC fields', () => {
    const controller = new PlayingPracticeController();
    controller.setStringSelected('G', false);
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);
    controller.setPatternType('one-octave-scale');
    controller.start();

    // A#4 (466.16 Hz): an ABC session in a flat key would call this B-flat.
    const aSharp = voiced(466.164);
    controller.handleAnalysisFrame(aSharp, analyzeTunerReading(aSharp), 0);
    const state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ targetNoteLabel: 'D4' });
    expect((state.session as { liveFeedbackText: string }).liveFeedbackText).toMatch(
      /^Hearing A#4 \(/,
    );
    expect(state.session).not.toHaveProperty('score');
    expect(state.session).not.toHaveProperty('upcomingText');
  });
});

describe('PlayingPracticeController: give-up hands off to Drilling', () => {
  it('giveUp() ends the attempt and enters drilling mode, now showing live progress/feedback/dwell chrome and the skip-drill button instead of the give-up button (Phase 7)', () => {
    const controller = startSingleNoteSession();

    controller.giveUp();

    const state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toEqual({
      kind: 'active',
      mode: 'drilling',
      progressText: 'Drilling: 0 of 3 correct in a row · attempt 1 of 12',
      targetNoteLabel: 'G3',
      liveFeedbackText: '',
      dwellFraction: 0,
      showGiveUpButton: false,
      showSkipDrillButton: true,
      banner: undefined,
      // The target as it would be drawn on a staff (open G, no upcoming preview in Playing Practice).
      staffNotes: [{ spelling: { letter: 'G', accidental: 0, octave: 3 }, role: 'target' }],
    });
  });
});

describe('PlayingPracticeController: Drilling reuses live feedback + dwell progress (Phase 7)', () => {
  it('a drilling rep updates liveFeedbackText and dwellFraction exactly like a Playing Practice attempt', () => {
    const controller = startSingleNoteSession(); // single G3 note -- see helper's own comment
    controller.giveUp(); // enters Drilling on G3 (the pool's only note)

    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling',
      liveFeedbackText: '',
      dwellFraction: 0,
    });

    controller.handleAnalysisFrame(unvoiced, analyzeTunerReading(unvoiced), 0);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ mode: 'drilling', liveFeedbackText: 'No signal' });

    // 5 frames @ 20ms = 100ms held, partway toward the 150ms default dwell
    // threshold -- confirms the dwell bar fills during a drilling rep too
    // (Phase 7: no longer suppressed for isDrilling, see
    // playing-practice-controller.ts's module doc comment).
    let t = 20;
    for (let i = 0; i < 5; i++) {
      const reading = voiced(196); // G3
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), t);
      t += 20;
    }
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session.mode).toBe('drilling');
    const activeSession = state.session as Extract<
      typeof state.session,
      { liveFeedbackText: string }
    >;
    expect(activeSession.liveFeedbackText).toMatch(/^Hearing G3 \(\+0c from target\)$/);
    expect(activeSession.dwellFraction).toBeGreaterThan(0);
    expect(activeSession.dwellFraction).toBeLessThan(1);
  });
});

describe('PlayingPracticeController: skipDrill()', () => {
  it('is a no-op while not drilling', () => {
    const controller = startSingleNoteSession();
    expect(() => controller.skipDrill()).not.toThrow();
    const state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session.mode).toBe('playing-practice');
  });

  it('is a no-op before any session has started', () => {
    const controller = new PlayingPracticeController();
    expect(() => controller.skipDrill()).not.toThrow();
    expect(controller.getViewState().phase).toBe('config');
  });

  it('immediately abandons the drill with no banner/pause, resuming Playing Practice at the note after the failed one', () => {
    const reference = generatePlayingPracticeSequence({
      strings: ['G', 'D'],
      patternType: 'open-strings',
    });
    expect(reference.map((n) => n.note.label)).toEqual(['G3', 'D4']);

    const controller = new PlayingPracticeController();
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);
    controller.setPatternType('open-strings'); // G,D open-strings-only => [G3, D4]
    controller.start();

    controller.giveUp(); // fail note 1 (G3) -> enters Drilling
    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session.mode).toBe('drilling');

    controller.skipDrill();
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'D4', // resumeAtIndex = 0 + 1 = 1
      banner: undefined, // no flourish for a manual skip, mirroring apps/desktop
    });
  });
});

describe('PlayingPracticeController: restart()', () => {
  it('returns to the config phase from an active session, discarding it entirely', () => {
    const controller = startSingleNoteSession();
    controller.restart();

    const state = controller.getViewState();
    expectConfig(state);
    expect(state.configError).toBeUndefined();
  });

  it('a subsequent handleAnalysisFrame() after restart() is a no-op (no dangling session)', () => {
    const controller = startSingleNoteSession();
    controller.restart();
    const reading = voiced(196);
    expect(() =>
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), 0),
    ).not.toThrow();
    expect(controller.getViewState().phase).toBe('config');
  });
});

describe('PlayingPracticeController: succeeding on the last note of a sequence', () => {
  it('goes straight to the complete phase without ever showing a success banner (no later frame would clear the pause)', () => {
    const controller = startSingleNoteSession();
    let t = 0;
    let state = controller.getViewState();

    while (!(state.phase === 'session' && state.session.kind === 'complete')) {
      const reading = voiced(196); // G3
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), t);
      state = controller.getViewState();
      if (state.phase === 'session' && state.session.kind === 'active') {
        expect(state.session.banner).toBeUndefined();
      }
      t += 20;
      if (t > 5000) throw new Error('test bug: session never completed');
    }

    expect(state).toEqual({ phase: 'session', session: { kind: 'complete' } });
  });
});

describe('PlayingPracticeController: multi-note hand-off (integration)', () => {
  it('a mid-sequence success shows the banner, and once the pause elapses the very same next frame both reveals and starts scoring the next target', () => {
    const reference = generatePlayingPracticeSequence({
      strings: ['G'],
      patternType: 'stepwise-first-position',
    });
    expect(reference.map((n) => n.note.label)).toEqual(['G3', 'A3', 'B3', 'C4', 'D4']);

    const controller = new PlayingPracticeController();
    controller.setStringSelected('D', false);
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false); // G only; pattern/direction already default to stepwise-first-position/ascending
    controller.start();

    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ targetNoteLabel: 'G3', progressText: 'Note 1 of 5' });

    let t = 0;
    const firstFrequencyHz = reference[0]!.frequencyHz;
    while (true) {
      const reading = voiced(firstFrequencyHz);
      controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), t);
      const s = controller.getViewState();
      if (s.phase === 'session' && s.session.kind === 'active' && s.session.banner !== undefined)
        break;
      t += 20;
      if (t > 5000) throw new Error('test bug: note 1 never succeeded');
    }

    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      banner: { text: 'Nice!', tone: 'success' },
      targetNoteLabel: 'G3',
    });

    // Advance past the 700ms success pause; feed one frame already in tune
    // for note 2 -- this single frame must both reveal note 2 AND
    // immediately start counting its dwell (the "fall through" behavior
    // documented in playing-practice-controller.ts's handleAnalysisFrame).
    t += 720;
    const secondFrequencyHz = reference[1]!.frequencyHz;
    const secondReading = voiced(secondFrequencyHz);
    controller.handleAnalysisFrame(secondReading, analyzeTunerReading(secondReading), t);

    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'A3',
      progressText: 'Note 2 of 5',
      banner: undefined,
      dwellFraction: 0, // already tracking note 2, zero elapsed on its very first frame
    });
  });
});

describe('PlayingPracticeController: give-up -> Drilling -> mastery -> resume (integration)', () => {
  it('a manual give-up on note 1 of a 2-note sequence drills to mastery (with a "Mastered!" pause) and correctly resumes Playing Practice on note 2, which then completes the session', () => {
    const reference = generatePlayingPracticeSequence({
      strings: ['G', 'D'],
      patternType: 'open-strings',
    });
    expect(reference.map((n) => n.note.label)).toEqual(['G3', 'D4']);

    const controller = new PlayingPracticeController();
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);
    controller.setPatternType('open-strings'); // G,D open-strings-only => [G3, D4]
    controller.start();

    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ mode: 'playing-practice', targetNoteLabel: 'G3' });

    controller.giveUp(); // fail note 1 (G3) manually
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'G3',
      progressText: 'Drilling: 0 of 3 correct in a row · attempt 1 of 12',
      showSkipDrillButton: true,
      showGiveUpButton: false,
    });

    let t = 0;
    function driveOneDwellSuccess(frequencyHz: number): void {
      // 10 frames @ 20ms comfortably crosses the 150ms default dwell
      // threshold partway through; the remaining frames in this same call
      // land against whatever the *next* tracker now targets and are
      // harmlessly out of tolerance for it (see the controller's own
      // comment on renderCurrentState() always building a fresh tracker).
      for (let i = 0; i < 10; i++) {
        const reading = voiced(frequencyHz);
        controller.handleAnalysisFrame(reading, analyzeTunerReading(reading), t);
        t += 20;
      }
    }

    // Rep 1: succeed on G3 (drilling's center note, the only pool entry
    // besides D4 -- G3 is the sequence's first note, so there's no
    // neighbor-below) -- rotates to D4. A 'continue' outcome gets no
    // banner/pause (only mastery/cap do, as of Phase 7), so the rotation is
    // visible immediately, same as before Phase 7.
    driveOneDwellSuccess(reference[0]!.frequencyHz);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'D4',
      progressText: 'Drilling: 1 of 3 correct in a row · attempt 2 of 12',
      banner: undefined,
    });

    // Rep 2: succeed on D4 -- rotates back to G3.
    driveOneDwellSuccess(reference[1]!.frequencyHz);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'G3',
      progressText: 'Drilling: 2 of 3 correct in a row · attempt 3 of 12',
    });

    // Rep 3: succeed on G3 again -- the 3rd consecutive correct rep
    // (default requiredConsecutiveCorrect), so drilling ends as mastered.
    // As of Phase 7 this shows a "Mastered!" banner and pauses
    // (SUCCESS_PAUSE_MS) *before* handing control back --
    // packages/core's PracticeSessionController has already internally
    // advanced (reportOutcome ran synchronously inside applyResult), but
    // the *displayed* mode/target-note stay on the drill's last rendered
    // frame until the pause elapses (mirrors apps/desktop's identical
    // "don't touch the target-note text during the pause" behavior).
    driveOneDwellSuccess(reference[0]!.frequencyHz);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling',
      targetNoteLabel: 'G3',
      banner: { text: 'Mastered!', tone: 'success' },
    });

    // Advance past the pause; one more in-tune D4 frame both reveals
    // Playing Practice's resumed note (resumeAtIndex = 0 + 1 = 1, i.e. D4,
    // per drilling.ts's documented resume-point policy) AND immediately
    // starts scoring it (the same "fall through" behavior the last-note/
    // multi-note-hand-off tests above exercise).
    t += 720;
    const secondReading = voiced(reference[1]!.frequencyHz);
    controller.handleAnalysisFrame(secondReading, analyzeTunerReading(secondReading), t);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'D4',
      progressText: 'Note 2 of 2',
      banner: undefined,
    });

    // D4 is the sequence's last note -- succeeding it completes the session
    // straight away (no pause -- see the dedicated last-note test above).
    driveOneDwellSuccess(reference[1]!.frequencyHz);
    state = controller.getViewState();
    expect(state).toEqual({ phase: 'session', session: { kind: 'complete' } });
  });
});

describe('PlayingPracticeController: repeated timeout hits the attempt cap ("Moving on") (integration)', () => {
  it('failing every drill rep via timeout up to maxAttempts shows a neutral "Moving on" banner, then resumes Playing Practice at the note after the failed one', () => {
    const reference = generatePlayingPracticeSequence({
      strings: ['G', 'D'],
      patternType: 'open-strings',
    });
    expect(reference.map((n) => n.note.label)).toEqual(['G3', 'D4']);

    const controller = new PlayingPracticeController();
    controller.setStringSelected('A', false);
    controller.setStringSelected('E', false);
    controller.setPatternType('open-strings'); // G,D open-strings-only => [G3, D4]
    controller.start();

    // Fail note 1 (G3) via the real, visible Playing Practice give-up
    // button -> enters Drilling. This first give-up doesn't count toward
    // DrillingMachine's own attemptsUsed (a fresh DrillingMachine starts at
    // 0), and it can never itself trigger a drill-ending banner (the
    // session was 'playing-practice' before it, not 'drilling') -- see
    // giveUp()'s own doc comment for why its performance.now() timestamp
    // domain matters starting this phase.
    controller.giveUp();
    let state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({ mode: 'drilling', targetNoteLabel: 'G3' });

    let t = 0;
    function timeOutOneAttempt(): void {
      // No signal for the whole attempt -- DEFAULT_ATTEMPT_TIMEOUT_MS
      // (10s) elapses with the clock still running regardless of signal
      // quality (see packages/core/CLAUDE.md's "Practice attempt
      // tracking" section), so this reliably fails every rep without ever
      // succeeding. Every failure here goes through handleAnalysisFrame
      // (not giveUp()), so the timestamp domain is the same synthetic `t`
      // throughout -- exactly how a real stuck drilling rep recovers in
      // production (the manual give-up button is hidden while drilling).
      controller.handleAnalysisFrame(unvoiced, analyzeTunerReading(unvoiced), t);
      t += 10_050;
      controller.handleAnalysisFrame(unvoiced, analyzeTunerReading(unvoiced), t);
      t += 50;
    }

    // Default maxAttempts is 12 -- 11 timeouts stay in the 'continue' zone
    // (no banner, consecutiveCorrect reset to 0 each time), and the 12th
    // hits the cap.
    for (let i = 0; i < 11; i++) {
      timeOutOneAttempt();
      state = controller.getViewState();
      expectActiveSession(state);
      expect(state.session.banner).toBeUndefined();
    }

    timeOutOneAttempt();
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'drilling', // cached/stale during the pause, same as the mastery case above
      banner: { text: 'Moving on', tone: 'neutral' },
    });

    // Advancing past the pause (same handleAnalysisFrame timestamp domain
    // throughout) reveals Playing Practice resumed at D4 (resumeAtIndex =
    // 0 + 1 = 1) -- capping isn't unrecoverable, per drilling.ts's
    // documented resume-point policy.
    t += 720;
    const secondReading = voiced(reference[1]!.frequencyHz);
    controller.handleAnalysisFrame(secondReading, analyzeTunerReading(secondReading), t);
    state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session).toMatchObject({
      mode: 'playing-practice',
      targetNoteLabel: 'D4',
      banner: undefined,
    });
  });
});

describe('PlayingPracticeController: drilling can be switched off', () => {
  /** Open strings G D A E, so a missed note has a next note to move on to. */
  function startFourNoteSession(drilling: boolean): PlayingPracticeController {
    const controller = new PlayingPracticeController();
    controller.setDrillingEnabled(drilling);
    controller.setPatternType('open-strings');
    controller.start();
    return controller;
  }

  it('with drilling off, a given-up note moves on instead of starting a drill', () => {
    const controller = startFourNoteSession(false);
    controller.giveUp();
    const state = controller.getViewState();
    expectActiveSession(state);
    // The "Moving on" banner is up for a moment, then the next note (D4) is the target; never a drill.
    expect(state.session.banner?.text).toBe('Moving on');
    expect(state.session.mode).not.toBe('drilling');
    expect(state.session.showSkipDrillButton).toBe(false);
  });

  it('with drilling off, a miss on the last note finishes the sequence', () => {
    const controller = startSingleNoteSession();
    controller.setDrillingEnabled(false);
    controller.giveUp();
    expect(controller.getViewState()).toMatchObject({ session: { kind: 'complete' } });
  });

  it('with drilling on (the default) a given-up note starts a drill as before', () => {
    const controller = startFourNoteSession(true);
    controller.giveUp();
    const state = controller.getViewState();
    expectActiveSession(state);
    expect(state.session.mode).toBe('drilling');
  });
});
