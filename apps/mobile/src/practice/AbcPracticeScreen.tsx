import { ScrollView, Text, View, Pressable, StyleSheet } from 'react-native';
import type { PlayAlongRunView } from '@violin/core';
import {
  ABC_STYLE_CHOICES,
  ABC_TRANSPOSE_CHOICES,
  type AbcCountInBars,
  type AbcPracticeStyle,
  type AbcPracticeViewState,
} from './abc-practice-controller';
import { PlayAlongPanel } from './PlayAlongPanel';
import {
  CaptureNotice,
  CompleteBlock,
  DrillingToggle,
  FingersToggle,
  NoteDisplayToggle,
  PillButton,
  SegmentedControl,
  SessionPanel,
  type NoteDisplay,
} from './PracticeParts';
import { TempoSettings } from './TempoSettings';

/**
 * The mobile ABC Notation screen, the RN analogue of apps/desktop's
 * `#abc-practice` section: import an ABC file, pick a tune, optionally
 * transpose by octaves, choose how to practice it, then practice its notes in
 * order. Two styles:
 *
 *  - **Play along** (default): a timed run with a (visual) metronome --
 *    tempo and count-in settings on the import screen, the live run in
 *    `./PlayAlongPanel.tsx`, results at the end. The tempo comes from the file
 *    and can be changed here without modifying it.
 *  - **Wait for me**: the original untimed flow, with the same session chrome
 *    (progress, target note, "Next:" preview, live feedback, dwell bar, banner,
 *    give-up/skip-drill, complete screen) as Playing Practice, via the shared
 *    `./PracticeParts.tsx`.
 *
 * Purely presentational, like `PlayingPracticeScreen.tsx`: all state lives in
 * `AbcPracticeController` (constructed in App.tsx) and arrives as
 * `viewState`; every action is forwarded through the callback props.
 */

export interface AbcPracticeScreenProps {
  readonly viewState: AbcPracticeViewState;
  readonly captureNotice:
    | {
        readonly message: string;
        readonly actionLabel: string | undefined;
      }
    | undefined;
  readonly onResumeCapture: () => void;
  /** Letters vs. staff for the target note -- shared with the Playing Practice screen, held in App.tsx. */
  readonly noteDisplay: NoteDisplay;
  readonly onSetNoteDisplay: (display: NoteDisplay) => void;
  readonly drilling: boolean;
  readonly onSetDrilling: (on: boolean) => void;
  readonly fingers: boolean;
  /** True while this tab is the visible one: a live play-along only polls for redraws then (the run itself carries on regardless). */
  readonly visible: boolean;
  /** Reads the live play-along run (`AbcPracticeController.getPlayAlongView`); must keep its identity. */
  readonly getPlayAlongView: () => PlayAlongRunView | undefined;
  readonly onImport: () => void;
  readonly onSelectTune: (index: number) => void;
  readonly onSetTranspose: (semitones: number) => void;
  readonly onSetStyle: (style: AbcPracticeStyle) => void;
  readonly onSetTempo: (bpm: number) => void;
  readonly onResetTempo: () => void;
  readonly onSetCountIn: (bars: AbcCountInBars) => void;
  readonly onSetFingers: (on: boolean) => void;
  readonly onStart: () => void;
  readonly onGiveUp: () => void;
  readonly onSkipDrill: () => void;
  readonly onStopPlayAlong: () => void;
  readonly onPlayAgain: () => void;
  readonly onPracticeMissed: () => void;
  /** Back to the import screen from a play-along's results ("Change settings") or a finished Wait-for-me session ("Practice another piece"). */
  readonly onRestart: () => void;
}

const TRANSPOSE_OPTIONS = ABC_TRANSPOSE_CHOICES.map((c) => ({
  value: c.semitones,
  label: c.label,
}));

export function AbcPracticeScreen({
  viewState,
  captureNotice,
  onResumeCapture,
  noteDisplay,
  onSetNoteDisplay,
  drilling,
  onSetDrilling,
  fingers,
  visible,
  getPlayAlongView,
  onImport,
  onSelectTune,
  onSetTranspose,
  onSetStyle,
  onSetTempo,
  onResetTempo,
  onSetCountIn,
  onSetFingers,
  onStart,
  onGiveUp,
  onSkipDrill,
  onStopPlayAlong,
  onPlayAgain,
  onPracticeMissed,
  onRestart,
}: AbcPracticeScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>ABC Notation</Text>
      </View>

      {captureNotice && <CaptureNotice notice={captureNotice} onAction={onResumeCapture} />}

      <NoteDisplayToggle value={noteDisplay} onChange={onSetNoteDisplay} />
      <DrillingToggle value={drilling} onChange={onSetDrilling} />
      <FingersToggle value={fingers} onChange={onSetFingers} />

      {viewState.phase === 'import' ? (
        <ImportPanel
          viewState={viewState}
          onImport={onImport}
          onSelectTune={onSelectTune}
          onSetTranspose={onSetTranspose}
          onSetStyle={onSetStyle}
          onSetTempo={onSetTempo}
          onResetTempo={onResetTempo}
          onSetCountIn={onSetCountIn}
          onStart={onStart}
        />
      ) : viewState.phase === 'play-along' ? (
        // Keyed by run: "Play again" mounts a fresh panel instead of briefly
        // showing the previous run's results.
        <PlayAlongPanel
          key={viewState.run.runId}
          run={viewState.run}
          getView={getPlayAlongView}
          noteDisplay={noteDisplay}
          active={visible}
          onStop={onStopPlayAlong}
          onPlayAgain={onPlayAgain}
          onPracticeMissed={onPracticeMissed}
          onChangeSettings={onRestart}
        />
      ) : viewState.session.kind === 'complete' ? (
        viewState.missedNotesOnly ? (
          // Just the notes missed in a play-along: offer to go straight back to it.
          <CompleteBlock
            message="Missed notes done!"
            buttonLabel="Play along again"
            onPress={onPlayAgain}
            secondary={{ label: 'Change settings', onPress: onRestart }}
          />
        ) : (
          <CompleteBlock
            message="Piece complete!"
            buttonLabel="Practice another piece"
            onPress={onRestart}
          />
        )
      ) : (
        <SessionPanel
          session={viewState.session}
          noteDisplay={noteDisplay}
          onGiveUp={onGiveUp}
          onSkipDrill={onSkipDrill}
        />
      )}
    </View>
  );
}

function ImportPanel({
  viewState,
  onImport,
  onSelectTune,
  onSetTranspose,
  onSetStyle,
  onSetTempo,
  onResetTempo,
  onSetCountIn,
  onStart,
}: {
  viewState: Extract<AbcPracticeViewState, { phase: 'import' }>;
  onImport: () => void;
  onSelectTune: (index: number) => void;
  onSetTranspose: (semitones: number) => void;
  onSetStyle: (style: AbcPracticeStyle) => void;
  onSetTempo: (bpm: number) => void;
  onResetTempo: () => void;
  onSetCountIn: (bars: AbcCountInBars) => void;
  onStart: () => void;
}) {
  const hasTunes = viewState.tunes.length > 0;
  const playAlong = viewState.style === 'play-along';
  return (
    <View style={styles.importBlock}>
      <Text style={styles.intro}>
        Import a sheet-music file in ABC notation (.abc) and practice it: play along with a beat, or
        let the app wait for each note.
      </Text>

      <PillButton
        label={viewState.loading ? 'Opening…' : 'Import ABC file…'}
        onPress={onImport}
        disabled={viewState.loading}
        primary
      />
      {viewState.fileName !== undefined && (
        <Text style={styles.fileName}>{viewState.fileName}</Text>
      )}

      {viewState.tunes.length > 1 && (
        <>
          <Text style={styles.fieldLabel}>Tune</Text>
          <ScrollView style={styles.tuneList} nestedScrollEnabled>
            {viewState.tunes.map((tune) => {
              const active = tune.index === viewState.selectedTuneIndex;
              return (
                <Pressable
                  key={tune.index}
                  onPress={() => onSelectTune(tune.index)}
                  style={[styles.tuneRow, active && styles.tuneRowActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.tuneRowLabel, active && styles.tuneRowLabelActive]}>
                    {tune.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      )}

      {hasTunes && (
        <>
          <Text style={styles.fieldLabel}>Transpose</Text>
          <SegmentedControl
            options={TRANSPOSE_OPTIONS}
            value={viewState.transposeSemitones}
            onChange={onSetTranspose}
          />
        </>
      )}

      {viewState.summaryText.length > 0 && (
        <Text style={styles.summary}>{viewState.summaryText}</Text>
      )}
      {viewState.warnings.map((warning) => (
        <Text key={warning} style={styles.warning}>
          • {warning}
        </Text>
      ))}
      {viewState.error !== undefined && <Text style={styles.error}>{viewState.error}</Text>}

      {hasTunes && (
        <>
          <Text style={styles.fieldLabel}>Practice style</Text>
          <SegmentedControl
            options={ABC_STYLE_CHOICES}
            value={viewState.style}
            onChange={onSetStyle}
          />
          <Text style={styles.styleHint}>
            {playAlong
              ? 'A beat keeps the tempo and the piece moves on by itself. Play each note in tune and on time.'
              : 'The app waits for you to play each note. A missed note is drilled with its neighbors.'}
          </Text>
        </>
      )}

      {playAlong && viewState.tempo !== undefined && (
        <TempoSettings
          tempo={viewState.tempo}
          countInBars={viewState.countInBars}
          onSetTempo={onSetTempo}
          onResetTempo={onResetTempo}
          onSetCountIn={onSetCountIn}
        />
      )}

      {hasTunes && (
        <PillButton
          label={playAlong ? 'Start playing along' : 'Start practicing'}
          onPress={onStart}
          disabled={!viewState.canStart}
          primary
        />
      )}
    </View>
  );
}

// Color palette matches PracticeParts.tsx / PlayingPracticeScreen.tsx (and
// apps/desktop/src/index.css): #1a1a1a text, #666 secondary, #999 labels,
// #8a5b00 amber warnings, #b91c1c errors, #eaf3ff/#8fbcf5/#1a4d8f the
// active-chip blue.
const styles = StyleSheet.create({
  screen: {
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  importBlock: {
    gap: 10,
  },
  intro: {
    fontSize: 13,
    color: '#555',
  },
  fileName: {
    alignSelf: 'center',
    fontSize: 12,
    color: '#666',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#999',
    marginTop: 4,
  },
  tuneList: {
    maxHeight: 180,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    borderRadius: 8,
  },
  tuneRow: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#f7f7f7',
  },
  tuneRowActive: {
    backgroundColor: '#eaf3ff',
  },
  tuneRowLabel: {
    fontSize: 13,
    color: '#666',
  },
  tuneRowLabelActive: {
    color: '#1a4d8f',
    fontWeight: '600',
  },
  styleHint: {
    fontSize: 12,
    color: '#666',
  },
  summary: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'Menlo, monospace',
    marginTop: 4,
  },
  warning: {
    fontSize: 12,
    color: '#8a5b00',
  },
  error: {
    fontSize: 13,
    fontWeight: '600',
    color: '#b91c1c',
  },
});
