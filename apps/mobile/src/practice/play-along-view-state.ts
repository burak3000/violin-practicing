/**
 * Pure helpers for rendering a live play-along run on React Native without
 * drowning React in updates.
 *
 * A run's `PlayAlongRunView` changes continuously (the playhead moves every
 * frame, the beat progress with it) but most of what is *visible* changes a
 * few times a second: a note resolves, the beat advances, the window moves to
 * the next bar, the feedback text changes. The screen polls the view at
 * ~30 fps (`PLAY_ALONG_POLL_MS`) and only calls `setState` when
 * `nextDisplayMark` says something visible changed; the playhead, which does
 * move continuously, is a separate tiny component fed straight from the poll
 * (see `PlayAlongPanel.tsx`) so moving it never re-renders the score.
 *
 * Kept free of React / React Native imports so the decisions (what the big
 * count-in cue says, when the beat "flashes", what counts as a visible change)
 * are unit-tested like the rest of this app's logic.
 */

import type { PlayAlongRunView } from '@violin/core';

/** How often the screen reads the run while one is live (~30 fps). */
export const PLAY_ALONG_POLL_MS = 33;

/** "Play!" stays up this long after the music starts (ms), then makes way for the notes. */
export const PLAY_CUE_DURATION_MS = 1000;

/** The beat dot counts as "flashing" for this fraction of the beat after its click. */
export const BEAT_FLASH_FRACTION = 0.3;

/** The dwell bar is redrawn in steps of 1/this (2%): finer changes are not visible and would cost a render each. */
export const DWELL_DISPLAY_STEPS = 50;

/**
 * What the big cue in the middle of the stage says:
 *  - `ready`: the run has started but the first click has not sounded yet
 *    ("Get ready");
 *  - `count`: the count-in, as a countdown of the clicks left (4, 3, 2, 1 --
 *    the last one is the beat before the music, a pickup piece's shorter count
 *    included);
 *  - `play`: the music has just started ("Play!");
 *  - `undefined`: no cue (the notes are on screen).
 */
export type PlayAlongCue =
  | { readonly kind: 'ready' }
  | { readonly kind: 'count'; readonly value: number }
  | { readonly kind: 'play' }
  | undefined;

export function cueFor(view: PlayAlongRunView): PlayAlongCue {
  if (view.phase === 'idle' || view.phase === 'count-in') {
    if (
      view.beat === undefined ||
      view.countInRemaining === undefined ||
      view.countInRemaining < 1
    ) {
      return { kind: 'ready' };
    }
    return { kind: 'count', value: view.countInRemaining };
  }
  if (view.phase === 'playing' && view.timeMs < PLAY_CUE_DURATION_MS) return { kind: 'play' };
  return undefined;
}

/** True during the first part of a beat, for the brief flash on the beat dot. */
export function beatFlashing(view: PlayAlongRunView): boolean {
  return view.beat !== undefined && view.beat.progress < BEAT_FLASH_FRACTION;
}

/** One dot of the beat indicator. */
export interface BeatDot {
  /** 1-based beat in the bar. */
  readonly beat: number;
  /** The downbeat: drawn larger/stronger. */
  readonly accent: boolean;
  /** The beat sounding now. */
  readonly lit: boolean;
}

/** Most dots drawn; a bar with more beats (16/4) shows its beat number as text instead. */
export const MAX_BEAT_DOTS = 12;

/** The beat indicator for a bar of `beatsPerBar` beats, or `undefined` when there are too many to draw as dots. */
export function beatDots(view: PlayAlongRunView): readonly BeatDot[] | undefined {
  const perBar = view.beat?.beatsPerBar;
  if (perBar === undefined) return undefined;
  if (perBar > MAX_BEAT_DOTS) return undefined;
  return Array.from({ length: perBar }, (_, i) => ({
    beat: i + 1,
    accent: i === 0,
    lit: view.beat?.inBar === i + 1,
  }));
}

/** Feedback text and the dwell bar change many times a second while sounding; they are redrawn at most this often (ms). */
export const FEEDBACK_MIN_INTERVAL_MS = 100;

/** What the panel last drew from the polled view (see `nextDisplayMark`). */
export interface DisplayMark {
  /** Everything except the feedback line and dwell bar. */
  readonly structural: string;
  /** The feedback line and the dwell bar's step. */
  readonly feedback: string;
  /** When the panel was last updated (poll clock, ms). */
  readonly atMs: number;
}

/**
 * Whether the panel needs a re-render for `view`, and if so the new mark to
 * remember. `undefined` means "nothing visible changed (enough)": the poll then
 * skips `setState`.
 *
 * A structural change (the phase, a note resolving, the beat, the cue, the
 * score window moving to another bar, the signal-lost banner, the results)
 * always updates. A change only in the live feedback text or the dwell bar --
 * which can flicker many times a second with the pitch -- updates at most every
 * `FEEDBACK_MIN_INTERVAL_MS`; the change is not lost, the next poll after the
 * interval sees it still differs. The playhead is deliberately not part of
 * this: it follows the poll directly (see `PlayAlongPanel.tsx`).
 *
 * `firstBar` is the bar the score window starts at, which the panel derives
 * from the position.
 */
export function nextDisplayMark(
  previous: DisplayMark | undefined,
  view: PlayAlongRunView,
  firstBar: number,
  nowMs: number,
): DisplayMark | undefined {
  const cue = cueFor(view);
  const beat = view.beat;
  const structural = [
    view.phase,
    view.noteStatesVersion,
    firstBar,
    cue === undefined ? '-' : cue.kind === 'count' ? `c${cue.value}` : cue.kind,
    beat === undefined
      ? '-'
      : `${beat.inBar}${beat.accent ? 'a' : ''}${beatFlashing(view) ? 'f' : ''}`,
    view.progressText,
    view.targetLabel,
    view.targetNoteIndex ?? '-', // the finger line follows it
    view.upcomingLabels.join(' '),
    view.signalLost ? 'lost' : 'ok',
    view.summary === undefined ? '-' : 'done',
  ].join('|');
  const feedback = `${view.liveFeedbackText}|${Math.round(view.dwellFraction * DWELL_DISPLAY_STEPS)}`;

  if (previous === undefined) return { structural, feedback, atMs: nowMs };
  if (structural !== previous.structural) return { structural, feedback, atMs: nowMs };
  if (feedback !== previous.feedback && nowMs - previous.atMs >= FEEDBACK_MIN_INTERVAL_MS) {
    return { structural, feedback, atMs: nowMs };
  }
  return undefined;
}
