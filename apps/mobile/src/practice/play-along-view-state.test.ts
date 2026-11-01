import { describe, expect, it } from 'vitest';
import {
  PlayAlongRunner,
  analyzeTunerReading,
  barIndexAtWhole,
  buildAbcPracticeSequence,
  midiToFrequencyHz,
  parseAbc,
  type PitchReading,
  type PlayAlongRunView,
} from '@violin/core';
import {
  BEAT_FLASH_FRACTION,
  FEEDBACK_MIN_INTERVAL_MS,
  MAX_BEAT_DOTS,
  PLAY_ALONG_POLL_MS,
  PLAY_CUE_DURATION_MS,
  beatDots,
  beatFlashing,
  cueFor,
  nextDisplayMark,
  type DisplayMark,
} from './play-along-view-state';

/** A view of a run that is playing normally; tests override the parts they care about. */
function view(overrides: Partial<PlayAlongRunView> = {}): PlayAlongRunView {
  return {
    phase: 'playing',
    timeMs: 3000,
    positionWhole: 0.5,
    countInRemaining: undefined,
    beat: { inBar: 2, beatsPerBar: 4, accent: false, progress: 0.5 },
    tempoText: '♩ = 92',
    progressText: 'Bar 1 of 4',
    noteStates: ['hit', 'due', 'pending'],
    noteStatesVersion: 3,
    dueNoteIndex: 1,
    targetNoteIndex: 1,
    targetLabel: 'D4',
    upcomingLabels: ['E4', 'F4'],
    liveFeedbackText: 'Hearing D4 (+3c from target)',
    dwellFraction: 0.4,
    signalLost: false,
    summary: undefined,
    ...overrides,
  };
}

describe('cueFor: the big cue in the middle of the stage', () => {
  it('counts down the clicks left during the count-in', () => {
    const counting = view({
      phase: 'count-in',
      timeMs: -3000,
      countInRemaining: 3,
      beat: { inBar: 2, beatsPerBar: 4, accent: false, progress: 0.2 },
    });
    expect(cueFor(counting)).toEqual({ kind: 'count', value: 3 });
  });

  it('says "get ready" before the first click, and when there is no count-in to show', () => {
    expect(cueFor(view({ phase: 'count-in', countInRemaining: 4, beat: undefined }))).toEqual({
      kind: 'ready',
    });
    expect(cueFor(view({ phase: 'count-in', countInRemaining: 0, beat: view().beat }))).toEqual({
      kind: 'ready',
    });
    expect(cueFor(view({ phase: 'idle', countInRemaining: undefined, beat: undefined }))).toEqual({
      kind: 'ready',
    });
  });

  it('cues "Play!" for the first second of music, then gets out of the way', () => {
    expect(cueFor(view({ timeMs: 0 }))).toEqual({ kind: 'play' });
    expect(cueFor(view({ timeMs: PLAY_CUE_DURATION_MS - 1 }))).toEqual({ kind: 'play' });
    expect(cueFor(view({ timeMs: PLAY_CUE_DURATION_MS }))).toBeUndefined();
  });

  it('has no cue once the run is over', () => {
    expect(cueFor(view({ phase: 'finished', timeMs: 100 }))).toBeUndefined();
  });
});

describe('beat indicator', () => {
  it('flashes only at the start of a beat', () => {
    const at = (progress: number) =>
      view({ beat: { inBar: 1, beatsPerBar: 4, accent: true, progress } });
    expect(beatFlashing(at(0))).toBe(true);
    expect(beatFlashing(at(BEAT_FLASH_FRACTION - 0.01))).toBe(true);
    expect(beatFlashing(at(BEAT_FLASH_FRACTION))).toBe(false);
    expect(beatFlashing(at(0.9))).toBe(false);
    expect(beatFlashing(view({ beat: undefined }))).toBe(false);
  });

  it('draws one dot per beat, the downbeat as the accent and the sounding beat lit', () => {
    const dots = beatDots(view({ beat: { inBar: 3, beatsPerBar: 4, accent: false, progress: 0 } }));
    expect(dots).toEqual([
      { beat: 1, accent: true, lit: false },
      { beat: 2, accent: false, lit: false },
      { beat: 3, accent: false, lit: true },
      { beat: 4, accent: false, lit: false },
    ]);
  });

  it('follows the meter: three dots in 3/4, two in 6/8', () => {
    expect(
      beatDots(view({ beat: { inBar: 1, beatsPerBar: 3, accent: true, progress: 0 } })),
    ).toHaveLength(3);
    expect(
      beatDots(view({ beat: { inBar: 2, beatsPerBar: 2, accent: false, progress: 0 } })),
    ).toHaveLength(2);
  });

  it('draws nothing before the first click, and falls back to text for a bar with too many beats', () => {
    expect(beatDots(view({ beat: undefined }))).toBeUndefined();
    expect(
      beatDots(
        view({ beat: { inBar: 1, beatsPerBar: MAX_BEAT_DOTS + 1, accent: true, progress: 0 } }),
      ),
    ).toBeUndefined();
    expect(
      beatDots(view({ beat: { inBar: 1, beatsPerBar: MAX_BEAT_DOTS, accent: true, progress: 0 } })),
    ).toHaveLength(MAX_BEAT_DOTS);
  });
});

describe('nextDisplayMark: when a poll is worth a render', () => {
  const T = 100_000;
  const first = (v = view(), bar = 0): DisplayMark => nextDisplayMark(undefined, v, bar, T)!;

  it('always draws the first view', () => {
    expect(nextDisplayMark(undefined, view(), 0, T)).toBeDefined();
  });

  it('draws nothing when only the playhead moved (it follows the poll directly)', () => {
    const mark = first();
    expect(
      nextDisplayMark(mark, view({ positionWhole: 0.6, timeMs: 3100 }), 0, T + 33),
    ).toBeUndefined();
  });

  it('redraws when a note resolves, the beat changes, or the window moves to another bar', () => {
    const mark = first();
    expect(nextDisplayMark(mark, view({ noteStatesVersion: 4 }), 0, T + 33)).toBeDefined();
    expect(
      nextDisplayMark(
        mark,
        view({ beat: { inBar: 3, beatsPerBar: 4, accent: false, progress: 0.1 } }),
        0,
        T + 33,
      ),
    ).toBeDefined();
    expect(nextDisplayMark(mark, view(), 1, T + 33)).toBeDefined();
  });

  it('redraws for the flash on and off within one beat, but not while the beat just goes on', () => {
    const beat = (progress: number) => ({ inBar: 2, beatsPerBar: 4, accent: false, progress });
    const flashOn = first(view({ beat: beat(0.05) }));
    expect(nextDisplayMark(flashOn, view({ beat: beat(0.1) }), 0, T + 33)).toBeUndefined();
    const off = nextDisplayMark(flashOn, view({ beat: beat(0.5) }), 0, T + 33);
    expect(off).toBeDefined();
    expect(nextDisplayMark(off, view({ beat: beat(0.8) }), 0, T + 66)).toBeUndefined();
  });

  it('redraws for the count-in number, the "Play!" cue, the banner and the results', () => {
    const counting = (n: number) =>
      view({
        phase: 'count-in',
        countInRemaining: n,
        timeMs: -1000 * n,
        beat: { inBar: 5 - n, beatsPerBar: 4, accent: n === 4, progress: 0.5 },
      });
    const mark = first(counting(3));
    expect(nextDisplayMark(mark, counting(2), 0, T + 33)).toBeDefined();

    const playing = first(view({ timeMs: 500 }));
    expect(nextDisplayMark(playing, view({ timeMs: 1200 }), 0, T + 33)).toBeDefined();

    const live = first();
    expect(nextDisplayMark(live, view({ signalLost: true }), 0, T + 33)).toBeDefined();
    expect(
      nextDisplayMark(
        live,
        view({
          phase: 'finished',
          summary: {
            headline: '3 of 3',
            tendency: undefined,
            misses: [],
            missedNoteIndices: [],
            hits: 3,
            total: 3,
            complete: true,
          },
        }),
        0,
        T + 33,
      ),
    ).toBeDefined();
  });

  it('throttles a flickering feedback line to one redraw per interval, without losing the change', () => {
    const mark = first();
    const flicker = view({ liveFeedbackText: 'Hearing D4 (+4c from target)' });
    expect(nextDisplayMark(mark, flicker, 0, T + FEEDBACK_MIN_INTERVAL_MS - 1)).toBeUndefined();
    // The next poll after the interval still sees the difference, so it is shown then.
    const later = nextDisplayMark(mark, flicker, 0, T + FEEDBACK_MIN_INTERVAL_MS);
    expect(later?.feedback).toContain('+4c');
    // And once shown, the same text is not drawn again.
    expect(
      nextDisplayMark(later, flicker, 0, T + FEEDBACK_MIN_INTERVAL_MS + 2 * PLAY_ALONG_POLL_MS),
    ).toBeUndefined();
  });

  it('shows the dwell bar in 2% steps (a smaller change is invisible)', () => {
    const mark = first(view({ dwellFraction: 0.4 }));
    const much = T + 10 * FEEDBACK_MIN_INTERVAL_MS;
    expect(nextDisplayMark(mark, view({ dwellFraction: 0.405 }), 0, much)).toBeUndefined();
    expect(nextDisplayMark(mark, view({ dwellFraction: 0.45 }), 0, much)).toBeDefined();
  });
});

describe('polling a real run costs few renders', () => {
  // Real runner on a hand-driven clock: poll it at the screen rate and count
  // how often the panel would actually have been re-rendered.
  const parsed = parseAbc('X:1\nM:4/4\nL:1/4\nQ:1/4=92\nK:C\nC D E F|G A B c|\n');
  const built = buildAbcPracticeSequence(parsed.tunes[0]!);
  if (built.status !== 'ok') throw new Error('fixture must be practicable');
  const piece = built.piece;

  it('re-renders on a small fraction of polls over a whole perfect run, and never loses the end', () => {
    const clock = { now: 1_000 };
    const runner = new PlayAlongRunner({
      piece,
      tempoBpm: 92,
      countInBeats: 4,
      nowMs: () => clock.now,
    });
    runner.start();
    const plan = runner.plan;
    const lag = 60;
    const reading = (planMs: number): PitchReading => {
      for (const n of plan.notes) {
        if (planMs >= n.onsetMs + lag && planMs < n.endMs + lag - 20) {
          return { voiced: true, frequencyHz: midiToFrequencyHz(n.midi), confidence: 1 };
        }
      }
      return { voiced: false, frequencyHz: 0, confidence: 0 };
    };

    let mark: DisplayMark | undefined;
    let polls = 0;
    let renders = 0;
    let lastView: PlayAlongRunView | undefined;
    const startMs = clock.now;
    const endMs = runner.zeroMs + plan.totalMs + 1800;
    let nextFrame = startMs;
    let nextPoll = startMs;
    for (let t = startMs; t <= endMs; t += 1) {
      clock.now = t;
      if (t >= nextFrame) {
        const r = reading(t - runner.zeroMs);
        runner.handleFrame(r, analyzeTunerReading(r), t);
        nextFrame += 11.6;
      }
      if (t >= nextPoll) {
        nextPoll += PLAY_ALONG_POLL_MS;
        const v = runner.getView();
        lastView = v;
        polls += 1;
        const next = nextDisplayMark(mark, v, barIndexAtWhole(piece, v.positionWhole), t);
        if (next) {
          mark = next;
          renders += 1;
        }
        if (v.phase === 'finished') break;
      }
    }
    expect(lastView?.phase).toBe('finished');
    expect(lastView?.summary?.headline).toBe('8 of 8 notes on time (100%)');
    expect(polls).toBeGreaterThan(200);
    // Beat changes, flashes, note resolutions and the cue are all there is to draw.
    expect(renders).toBeLessThan(polls / 3);
    expect(renders).toBeGreaterThan(20);
  });
});
