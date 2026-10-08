import { ScrollView, Text, View, Pressable, StyleSheet } from 'react-native';
import { ABC_TRANSPOSE_CHOICES, type AbcPracticeViewState } from './abc-practice-controller';
import {
  CaptureNotice,
  CompleteBlock,
  PillButton,
  SegmentedControl,
  SessionPanel,
} from './PracticeParts';

/**
 * The mobile ABC Notation screen, the RN analogue of apps/desktop's
 * `#abc-practice` section: import an ABC file, pick a tune, optionally
 * transpose by octaves, then practice its notes in order -- with the same
 * session chrome (progress, target note, "Next:" preview, live feedback,
 * dwell bar, banner, give-up/skip-drill, complete screen) as Playing
 * Practice, via the shared `./PracticeParts.tsx`.
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
  readonly onImport: () => void;
  readonly onSelectTune: (index: number) => void;
  readonly onSetTranspose: (semitones: number) => void;
  readonly onStart: () => void;
  readonly onGiveUp: () => void;
  readonly onSkipDrill: () => void;
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
  onImport,
  onSelectTune,
  onSetTranspose,
  onStart,
  onGiveUp,
  onSkipDrill,
  onRestart,
}: AbcPracticeScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>ABC Notation</Text>
      </View>

      {captureNotice && <CaptureNotice notice={captureNotice} onAction={onResumeCapture} />}

      {viewState.phase === 'import' ? (
        <ImportPanel
          viewState={viewState}
          onImport={onImport}
          onSelectTune={onSelectTune}
          onSetTranspose={onSetTranspose}
          onStart={onStart}
        />
      ) : viewState.session.kind === 'complete' ? (
        <CompleteBlock
          message="Piece complete!"
          buttonLabel="Practice another piece"
          onPress={onRestart}
        />
      ) : (
        <SessionPanel session={viewState.session} onGiveUp={onGiveUp} onSkipDrill={onSkipDrill} />
      )}
    </View>
  );
}

function ImportPanel({
  viewState,
  onImport,
  onSelectTune,
  onSetTranspose,
  onStart,
}: {
  viewState: Extract<AbcPracticeViewState, { phase: 'import' }>;
  onImport: () => void;
  onSelectTune: (index: number) => void;
  onSetTranspose: (semitones: number) => void;
  onStart: () => void;
}) {
  const hasTunes = viewState.tunes.length > 0;
  return (
    <View style={styles.importBlock}>
      <Text style={styles.intro}>
        Import a sheet-music file in ABC notation (.abc) and practice it note by note, the same way
        as a scale.
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
        <PillButton
          label="Start practicing"
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
