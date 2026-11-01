import { Text, TextInput, View, Pressable, StyleSheet } from 'react-native';
import {
  VIOLIN_STRING_ORDER,
  type SequenceDirection,
  type SequencePatternType,
  type ViolinStringName,
} from '@violin/core';
import type {
  PlayingPracticeConfigSnapshot,
  PlayingPracticePreview,
  PlayingPracticeViewState,
} from './playing-practice-controller';
import {
  CaptureNotice,
  CompleteBlock,
  DrillingToggle,
  NoteDisplayToggle,
  PillButton,
  SegmentedControl,
  SessionPanel,
  type NoteDisplay,
} from './PracticeParts';

/**
 * Phase 6 Part B: the mobile Playing Practice screen, the RN analogue of
 * apps/desktop's Phase 6 Part A `#playing-practice` section (see
 * apps/desktop/CLAUDE.md's "Playing Practice UI (Phase 6)" section and
 * apps/desktop/index.html's markup) -- same concepts (configurable
 * sequence, target note, live feedback, dwell progress, give-up button,
 * success banner, complete screen), ported to React Native controls rather
 * than a literal DOM/CSS translation: string selection as Pressable chips
 * instead of checkboxes, pattern/direction as a small segmented Pressable
 * group instead of `<select>`, and no `<details>` -- the config and session
 * views are simply two mutually-exclusive screens (see
 * `PlayingPracticeController`'s own doc comment for why this simplification
 * was chosen over mirroring `<details>`'s always-reachable summary
 * literally).
 *
 * **Phase 7 Part B update**: Drilling is real now, not a placeholder --
 * mirrors apps/desktop's Phase 7 Part A design (see
 * apps/desktop/CLAUDE.md's "Drilling UI (Phase 7)" section) in substance:
 * `SessionPanel` below no longer special-cases `session.mode === 'drilling'`
 * for the live-feedback line or dwell bar (both are always rendered from
 * `viewState.session`'s fields now, which `PlayingPracticeController`
 * populates identically for either mode), and a new "Skip this drill"
 * button (`onSkipDrill`) replaces -- never stacks with -- the existing
 * "Having trouble? Skip this note" button while drilling, via
 * `session.showGiveUpButton`/`showSkipDrillButton` (mutually exclusive).
 * The banner element also now renders one of three texts ("Nice!",
 * "Mastered!", "Moving on") via `session.banner`, with `tone: 'neutral'`
 * (the "Moving on" case) picking up the `successBannerNeutral` style
 * instead of the default green -- see that style's own comment.
 *
 * **ABC Notation update**: `SessionPanel`, `PillButton`, `SegmentedControl`
 * and the complete screen moved to `./PracticeParts.tsx` (unchanged) so the
 * ABC Notation screen (`./AbcPracticeScreen.tsx`) shares them rather than
 * copying them.
 *
 * Purely presentational, mirroring `FingerTunerScreen.tsx`'s own
 * convention exactly: every piece of state (the config controls' current
 * values, the live session view) is owned by `PlayingPracticeController`
 * (constructed in App.tsx) and passed in as `viewState`; every user action
 * is forwarded straight through the callback props below. This component
 * has no local state of its own and no reference to
 * `mic-capture-controller.ts`/`permissions.ts`/`@violin/dsp-ts` at all.
 */

export interface PlayingPracticeScreenProps {
  readonly viewState: PlayingPracticeViewState;
  readonly captureNotice:
    | {
        readonly message: string;
        readonly actionLabel: string | undefined;
      }
    | undefined;
  readonly onResumeCapture: () => void;
  /** Letters vs. staff for the target note -- shared with the ABC screen, held in App.tsx. */
  readonly noteDisplay: NoteDisplay;
  readonly onSetNoteDisplay: (display: NoteDisplay) => void;
  readonly drilling: boolean;
  readonly onSetDrilling: (on: boolean) => void;
  readonly onToggleString: (name: ViolinStringName, selected: boolean) => void;
  readonly onSetPatternType: (pattern: SequencePatternType) => void;
  readonly onSetDirection: (direction: SequenceDirection) => void;
  readonly onSetMinFrequencyText: (text: string) => void;
  readonly onSetMaxFrequencyText: (text: string) => void;
  readonly onStart: () => void;
  readonly onGiveUp: () => void;
  /** "Skip this drill" (Phase 7) -- see `PlayingPracticeController.skipDrill()`. Only ever rendered while `session.showSkipDrillButton` is true (mutually exclusive with `onGiveUp`'s button). */
  readonly onSkipDrill: () => void;
  readonly onRestart: () => void;
}

export function PlayingPracticeScreen({
  viewState,
  captureNotice,
  onResumeCapture,
  noteDisplay,
  onSetNoteDisplay,
  drilling,
  onSetDrilling,
  onToggleString,
  onSetPatternType,
  onSetDirection,
  onSetMinFrequencyText,
  onSetMaxFrequencyText,
  onStart,
  onGiveUp,
  onSkipDrill,
  onRestart,
}: PlayingPracticeScreenProps) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Playing Practice</Text>
      </View>

      {captureNotice && <CaptureNotice notice={captureNotice} onAction={onResumeCapture} />}

      <NoteDisplayToggle value={noteDisplay} onChange={onSetNoteDisplay} />
      <DrillingToggle value={drilling} onChange={onSetDrilling} />

      {viewState.phase === 'config' ? (
        <ConfigPanel
          config={viewState.config}
          preview={viewState.preview}
          configError={viewState.configError}
          onToggleString={onToggleString}
          onSetPatternType={onSetPatternType}
          onSetDirection={onSetDirection}
          onSetMinFrequencyText={onSetMinFrequencyText}
          onSetMaxFrequencyText={onSetMaxFrequencyText}
          onStart={onStart}
        />
      ) : viewState.session.kind === 'complete' ? (
        <CompleteBlock
          message="Sequence complete!"
          buttonLabel="Start a new sequence"
          onPress={onRestart}
        />
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

const PATTERN_OPTIONS: ReadonlyArray<{ value: SequencePatternType; label: string }> = [
  { value: 'open-strings', label: 'Open strings' },
  { value: 'stepwise-first-position', label: 'Stepwise (1st pos.)' },
  { value: 'one-octave-scale', label: 'One-octave scale' },
];

const DIRECTION_OPTIONS: ReadonlyArray<{ value: SequenceDirection; label: string }> = [
  { value: 'ascending', label: 'Ascending' },
  { value: 'descending', label: 'Descending' },
  { value: 'both', label: 'Both' },
];

function ConfigPanel({
  config,
  preview,
  configError,
  onToggleString,
  onSetPatternType,
  onSetDirection,
  onSetMinFrequencyText,
  onSetMaxFrequencyText,
  onStart,
}: {
  config: PlayingPracticeConfigSnapshot;
  preview: PlayingPracticePreview;
  configError: string | undefined;
  onToggleString: (name: ViolinStringName, selected: boolean) => void;
  onSetPatternType: (pattern: SequencePatternType) => void;
  onSetDirection: (direction: SequenceDirection) => void;
  onSetMinFrequencyText: (text: string) => void;
  onSetMaxFrequencyText: (text: string) => void;
  onStart: () => void;
}) {
  return (
    <View style={styles.configBlock}>
      <Text style={styles.sectionTitle}>Sequence settings</Text>

      <Text style={styles.fieldLabel}>Strings</Text>
      <View style={styles.stringsRow}>
        {VIOLIN_STRING_ORDER.map((name) => (
          <Chip
            key={name}
            label={name}
            active={config.strings[name]}
            onPress={() => onToggleString(name, !config.strings[name])}
          />
        ))}
      </View>

      <Text style={styles.fieldLabel}>Pattern</Text>
      <SegmentedControl
        options={PATTERN_OPTIONS}
        value={config.patternType}
        onChange={onSetPatternType}
      />

      <Text style={styles.fieldLabel}>Direction</Text>
      <SegmentedControl
        options={DIRECTION_OPTIONS}
        value={config.direction}
        onChange={onSetDirection}
      />

      <View style={styles.freqRow}>
        <View style={styles.freqField}>
          <Text style={styles.fieldLabel}>Min frequency (Hz)</Text>
          <TextInput
            style={styles.freqInput}
            value={config.minFrequencyText}
            onChangeText={onSetMinFrequencyText}
            keyboardType="numeric"
            accessibilityLabel="Minimum frequency in Hertz"
          />
        </View>
        <View style={styles.freqField}>
          <Text style={styles.fieldLabel}>Max frequency (Hz)</Text>
          <TextInput
            style={styles.freqInput}
            value={config.maxFrequencyText}
            onChangeText={onSetMaxFrequencyText}
            keyboardType="numeric"
            accessibilityLabel="Maximum frequency in Hertz"
          />
        </View>
      </View>

      <Text style={styles.preview}>{preview.text}</Text>
      {configError !== undefined && <Text style={styles.configError}>{configError}</Text>}

      <PillButton label="Start sequence" onPress={onStart} primary />
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

// Color palette matches apps/desktop/src/index.css's "Playing Practice
// (Phase 6)"/"Drilling UI (Phase 7)" sections exactly (#1a7f37 success
// green, #8a5b00 drilling amber, #b91c1c error red, #1a1a1a target-note
// dark, #666 secondary text, #1a4d8f neutral "Moving on" blue -- see
// successBannerNeutral below, which reuses this file's own existing
// active-chip/segment/mode-tab blue rather than inventing a new hue, same
// as desktop's own comment on that color choice) so the two apps' Playing
// Practice modes read as the same product, same as this app's own Finger
// Tuner screen already does relative to desktop's.
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

  // --- Config panel --------------------------------------------------
  configBlock: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#999',
    marginTop: 4,
  },
  stringsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: '#eaf3ff',
    borderColor: '#8fbcf5',
  },
  chipLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#999',
  },
  chipLabelActive: {
    color: '#1a4d8f',
  },
  freqRow: {
    flexDirection: 'row',
    gap: 16,
  },
  freqField: {
    gap: 4,
  },
  freqInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    width: 90,
    fontSize: 14,
    color: '#1a1a1a',
  },
  preview: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'Menlo, monospace',
    marginTop: 4,
  },
  configError: {
    fontSize: 13,
    fontWeight: '600',
    color: '#b91c1c',
  },

  // --- Session panel ----------------------------------------------------
  // Drilling's "Moving on" (max-attempts-reached) reuses successBanner
  // itself (see PlayingPracticeController's showDrillEndBanner()) but reads
  // as neutral, not a win -- capping isn't a failure to punish. Matches
  // this file's own existing active-chip/segment/mode-tab blue (#1a4d8f)
  // rather than inventing a new hue, mirroring
  // apps/desktop/src/index.css's identical `.pp-banner-neutral` choice.

  // --- Complete screen ---------------------------------------------------

  // --- Shared button --------------------------------------------------
});
