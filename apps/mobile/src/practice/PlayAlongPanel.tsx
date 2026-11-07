import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  barIndexAtWhole,
  describeFinger,
  type FingerMark,
  type PlayAlongRunView,
} from '@violin/core';
import type { AbcPlayAlongRunInfo } from './abc-practice-controller';
import {
  PLAY_ALONG_POLL_MS,
  beatDots,
  beatFlashing,
  cueFor,
  nextDisplayMark,
  type DisplayMark,
  type PlayAlongCue,
} from './play-along-view-state';
import { DwellBar, LiveFeedbackLine, PillButton, type NoteDisplay } from './PracticeParts';
import { ScoreView, type PlayheadSource } from './ScoreView';

/**
 * The live timed play-along (ABC Notation > Play along): beat dots, the count-in
 * number and "Play!" cue, the score (or the big letter name) with each note
 * coloured by how it went, a moving playhead, the live feedback line and dwell
 * bar, and -- when the run ends -- the results card. The mobile counterpart of
 * the desktop play-along view, and like the other screens purely presentational:
 * the run itself is `packages/core`'s `PlayAlongRunner`, owned by
 * `AbcPracticeController`.
 *
 * ## How it stays cheap on React Native
 *
 * Analysis frames arrive ~86 times a second; none of them reaches React. This
 * panel polls `getView()` every `PLAY_ALONG_POLL_MS` (~30 fps) **only while the
 * run is live and this tab is showing**, and calls `setState` only when
 * `nextDisplayMark` says something visible changed (and the flickering feedback
 * text at most every 100 ms). The playhead moves continuously, so it is its own
 * component fed straight from the poll; the notation is memoized and redrawn
 * only when a note's state changes or the window moves to another bar. The run
 * itself is clock-driven, so a hidden tab misses nothing: when it is shown again
 * the next poll catches up at once.
 *
 * ## Display
 *
 * "Letters" shows the big name of the note the player is on (coloured by its
 * result) and the next few; "Staff" shows the notated score starting at the
 * current bar. The count-in number and the "Play!" cue are laid over the stage,
 * not in front of it, so the layout under them does not move when they go.
 *
 * ## The click
 *
 * Mobile shows the beat; it does not play it (see `abc-practice-controller.ts`
 * for why), and the panel says so in the tempo settings.
 */

/** The list of missed notes is cut here; the rest are counted. */
const MAX_LISTED_MISSES = 24;

interface Shown {
  readonly view: PlayAlongRunView;
  readonly firstBar: number;
}

/**
 * Polls the run while `active`, returning what to draw and a `PlayheadSource`.
 * Stops polling by itself once the run has finished.
 */
function usePlayAlongRun(
  getView: () => PlayAlongRunView | undefined,
  run: AbcPlayAlongRunInfo,
  active: boolean,
): { shown: Shown | undefined; playhead: PlayheadSource } {
  const markRef = useRef<DisplayMark | undefined>(undefined);
  const listenersRef = useRef(new Set<(view: PlayAlongRunView) => void>());
  const latestRef = useRef<PlayAlongRunView | undefined>(undefined);

  const [shown, setShown] = useState<Shown | undefined>(() => {
    const view = getView();
    return view ? { view, firstBar: barIndexAtWhole(run.piece, view.positionWhole) } : undefined;
  });

  useEffect(() => {
    if (!active) return undefined;
    const tick = (): boolean => {
      const view = getView();
      if (!view) return false;
      latestRef.current = view;
      const firstBar = barIndexAtWhole(run.piece, view.positionWhole);
      const mark = nextDisplayMark(markRef.current, view, firstBar, performance.now());
      if (mark) {
        markRef.current = mark;
        setShown({ view, firstBar });
      }
      for (const listener of listenersRef.current) listener(view);
      return view.phase !== 'finished';
    };
    // Draw immediately (also when the tab is shown again), then keep polling
    // for as long as the run is live.
    if (!tick()) return undefined;
    const id = setInterval(() => {
      if (!tick()) clearInterval(id);
    }, PLAY_ALONG_POLL_MS);
    return () => clearInterval(id);
  }, [getView, run, active]);

  const playhead = useRef<PlayheadSource>({
    subscribe(listener) {
      listenersRef.current.add(listener);
      if (latestRef.current) listener(latestRef.current);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
  }).current;

  return { shown, playhead };
}

export interface PlayAlongPanelProps {
  readonly run: AbcPlayAlongRunInfo;
  /** Reads the live run (`AbcPracticeController.getPlayAlongView`); stable identity. */
  readonly getView: () => PlayAlongRunView | undefined;
  readonly noteDisplay: NoteDisplay;
  /** False while this tab is hidden: polling pauses (the run itself carries on). */
  readonly active: boolean;
  readonly onStop: () => void;
  readonly onPlayAgain: () => void;
  readonly onPracticeMissed: () => void;
  readonly onChangeSettings: () => void;
}

export function PlayAlongPanel({
  run,
  getView,
  noteDisplay,
  active,
  onStop,
  onPlayAgain,
  onPracticeMissed,
  onChangeSettings,
}: PlayAlongPanelProps) {
  const { shown, playhead } = usePlayAlongRun(getView, run, active);
  if (!shown) return null;
  const { view, firstBar } = shown;
  const finished = view.phase === 'finished';

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.tempo}>{view.tempoText}</Text>
        {!finished && <PillButton label="Stop" onPress={onStop} />}
      </View>
      <Text style={styles.progress}>{finished ? 'Finished' : view.progressText}</Text>

      {finished && view.summary ? (
        <ResultsCard
          summary={view.summary}
          onPlayAgain={onPlayAgain}
          onPracticeMissed={onPracticeMissed}
          onChangeSettings={onChangeSettings}
        />
      ) : (
        <>
          <BeatDots view={view} />

          {view.signalLost && (
            <Text style={styles.signalLost}>
              No audio input — start the input on the Finger Tuner tab.
            </Text>
          )}

          <View style={styles.stage}>
            {noteDisplay === 'staff' ? (
              <ScoreView
                piece={run.piece}
                firstBar={firstBar}
                noteStates={view.noteStates}
                playhead={playhead}
                fingers={run.fingers}
              />
            ) : (
              <LettersStage view={view} fingers={run.fingers} />
            )}
            <CueOverlay cue={cueFor(view)} />
          </View>

          <View style={styles.feedback}>
            <LiveFeedbackLine text={view.liveFeedbackText} />
            <DwellBar fraction={view.dwellFraction} />
          </View>
        </>
      )}
    </View>
  );
}

// --- Pieces ----------------------------------------------------------------

/** One dot per beat of the bar: the downbeat larger, the beat sounding now filled (and swelling briefly on its click). */
function BeatDots({ view }: { view: PlayAlongRunView }) {
  const dots = beatDots(view);
  const flashing = beatFlashing(view);
  if (!dots) {
    // A bar with too many beats to draw as dots: just say which one it is.
    return view.beat ? (
      <Text style={styles.beatNumber}>
        Beat {view.beat.inBar} of {view.beat.beatsPerBar}
      </Text>
    ) : null;
  }
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no">
      {dots.map((dot) => {
        const size = (dot.accent ? 22 : 16) + (dot.lit && flashing ? 6 : 0);
        return (
          <View key={dot.beat} style={styles.dotSlot}>
            <View
              style={[
                styles.dot,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                },
                dot.accent && styles.dotAccent,
                dot.lit && (dot.accent ? styles.dotLitAccent : styles.dotLit),
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

function LettersStage({
  view,
  fingers,
}: {
  view: PlayAlongRunView;
  fingers: readonly (FingerMark | undefined)[] | undefined;
}) {
  const mark =
    fingers === undefined || view.targetNoteIndex === undefined
      ? undefined
      : fingers[view.targetNoteIndex];
  const dueState = view.dueNoteIndex === undefined ? undefined : view.noteStates[view.dueNoteIndex];
  return (
    <View style={styles.letters}>
      <Text
        style={[
          styles.targetLabel,
          dueState === 'due' && styles.targetDue,
          dueState === 'hit' && styles.targetHit,
          dueState === 'missed' && styles.targetMissed,
        ]}
      >
        {view.targetLabel.length > 0 ? view.targetLabel : '—'}
      </Text>
      <Text style={styles.finger}>{describeFinger(mark) || ' '}</Text>
      <Text style={styles.upcoming}>
        {view.upcomingLabels.length > 0 ? `Next: ${view.upcomingLabels.join(' ')}` : ' '}
      </Text>
    </View>
  );
}

/** The big count-in number / "Get ready" / "Play!" laid over the stage. */
function CueOverlay({ cue }: { cue: PlayAlongCue }) {
  if (!cue) return null;
  return (
    <View style={styles.cueOverlay} pointerEvents="none">
      {cue.kind === 'count' && <Text style={styles.cueCount}>{cue.value}</Text>}
      {cue.kind === 'ready' && <Text style={styles.cueReady}>Get ready…</Text>}
      {cue.kind === 'play' && <Text style={styles.cuePlay}>Play!</Text>}
    </View>
  );
}

function ResultsCard({
  summary,
  onPlayAgain,
  onPracticeMissed,
  onChangeSettings,
}: {
  summary: NonNullable<PlayAlongRunView['summary']>;
  onPlayAgain: () => void;
  onPracticeMissed: () => void;
  onChangeSettings: () => void;
}) {
  const listed = summary.misses.slice(0, MAX_LISTED_MISSES);
  const hidden = summary.misses.length - listed.length;
  const perfect = summary.complete && summary.misses.length === 0;
  return (
    <View style={styles.results}>
      <Text style={styles.resultsHeadline}>{summary.headline}</Text>
      {summary.tendency !== undefined && <Text style={styles.tendency}>{summary.tendency}</Text>}
      {!summary.complete && <Text style={styles.stopped}>You stopped before the end.</Text>}

      {perfect ? (
        <Text style={styles.perfect}>Every note was in tune and on time. Well played!</Text>
      ) : (
        summary.misses.length > 0 && (
          <View style={styles.misses}>
            <Text style={styles.missesLabel}>Notes to work on</Text>
            {listed.map((miss) => (
              <Text key={miss.noteIndex} style={styles.miss}>
                {miss.text}
              </Text>
            ))}
            {hidden > 0 && <Text style={styles.missMore}>…and {hidden} more</Text>}
          </View>
        )
      )}

      <View style={styles.resultsButtons}>
        <PillButton label="Play again" onPress={onPlayAgain} primary />
        {summary.misses.length > 0 && (
          <PillButton label="Practice missed notes" onPress={onPracticeMissed} />
        )}
        <PillButton label="Change settings" onPress={onChangeSettings} />
      </View>
    </View>
  );
}

// Palette matches PracticeParts.tsx / the other practice screens: #1a1a1a ink,
// #666 secondary, #2563eb blue (due / primary), #1a7f37 green (hit),
// #b91c1c red (missed), #8a5b00 amber (warnings).
const styles = StyleSheet.create({
  panel: {
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tempo: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    fontVariant: ['tabular-nums'],
  },
  progress: {
    textAlign: 'center',
    fontSize: 12,
    color: '#666',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    height: 34,
  },
  dotSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 34,
  },
  dot: {
    borderWidth: 2,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  dotAccent: {
    borderColor: '#94a3b8',
  },
  dotLit: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  dotLitAccent: {
    backgroundColor: '#ea580c',
    borderColor: '#ea580c',
  },
  beatNumber: {
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    color: '#2563eb',
  },
  signalLost: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8a5b00',
    backgroundColor: '#fff7e6',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    textAlign: 'center',
  },
  stage: {
    minHeight: 130,
    justifyContent: 'center',
  },
  letters: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  finger: {
    fontSize: 18,
    color: '#1a1a1a',
    textAlign: 'center',
  },
  targetLabel: {
    fontSize: 64,
    fontWeight: '700',
    color: '#1a1a1a',
    fontVariant: ['tabular-nums'],
  },
  // The same colours the notes get on the staff: due (blue) -> hit (green) / missed (red).
  targetDue: {
    color: '#2563eb',
  },
  targetHit: {
    color: '#1a7f37',
  },
  targetMissed: {
    color: '#b91c1c',
  },
  upcoming: {
    fontFamily: 'Menlo, monospace',
    fontSize: 14,
    color: '#999',
  },
  cueOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
  },
  cueCount: {
    fontSize: 104,
    fontWeight: '800',
    color: '#2563eb',
    fontVariant: ['tabular-nums'],
  },
  cueReady: {
    fontSize: 30,
    fontWeight: '700',
    color: '#666',
  },
  cuePlay: {
    fontSize: 72,
    fontWeight: '800',
    color: '#1a7f37',
  },
  feedback: {
    alignItems: 'center',
    gap: 4,
  },
  results: {
    gap: 8,
    alignItems: 'stretch',
  },
  resultsHeadline: {
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    marginTop: 6,
  },
  tendency: {
    textAlign: 'center',
    fontSize: 14,
    color: '#444',
  },
  stopped: {
    textAlign: 'center',
    fontSize: 13,
    color: '#8a5b00',
  },
  perfect: {
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: '#1a7f37',
    marginTop: 6,
  },
  misses: {
    gap: 4,
    marginTop: 8,
  },
  missesLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#999',
  },
  miss: {
    fontSize: 13,
    color: '#b91c1c',
  },
  missMore: {
    fontSize: 12,
    color: '#666',
  },
  resultsButtons: {
    alignItems: 'center',
    marginTop: 4,
  },
});
