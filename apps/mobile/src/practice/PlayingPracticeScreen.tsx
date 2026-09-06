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
  PlayingPracticeSessionViewState,
  PlayingPracticeViewState,
} from './playing-practice-controller';

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

      {captureNotice && (
        <View style={styles.captureNotice}>
          <Text style={styles.captureNoticeText}>{captureNotice.message}</Text>
          {captureNotice.actionLabel && (
            <PillButton label={captureNotice.actionLabel} onPress={onResumeCapture} primary />
          )}
        </View>
      )}

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
        <View style={styles.completeBlock}>
          <Text style={styles.completeMessage}>Sequence complete!</Text>
          <PillButton label="Start a new sequence" onPress={onRestart} primary />
        </View>
      ) : (
        <SessionPanel session={viewState.session} onGiveUp={onGiveUp} onSkipDrill={onSkipDrill} />
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

function SessionPanel({
  session,
  onGiveUp,
  onSkipDrill,
}: {
  session: Extract<PlayingPracticeSessionViewState, { kind: 'active' }>;
  onGiveUp: () => void;
  onSkipDrill: () => void;
}) {
  const isDrilling = session.mode === 'drilling';
  return (
    <View style={styles.session}>
      <Text style={styles.progress}>{session.progressText}</Text>

      <View style={styles.target}>
        {isDrilling && <Text style={styles.modeLabel}>Drilling</Text>}
        <Text style={styles.targetNote}>{session.targetNoteLabel}</Text>

        {/* Live feedback + dwell bar: reused verbatim by Drilling as of
            Phase 7 (see this file's own doc comment) -- no longer gated on
            `!isDrilling` or an `!== undefined` check, since
            PlayingPracticeController now populates both fields identically
            for either mode. */}
        {session.liveFeedbackText.length > 0 && (
          <Text style={styles.liveFeedback}>{session.liveFeedbackText}</Text>
        )}

        <View style={styles.dwellTrack}>
          <View style={[styles.dwellFill, { width: `${session.dwellFraction * 100}%` }]} />
        </View>

        {session.banner !== undefined && (
          <Text
            style={[
              styles.successBanner,
              session.banner.tone === 'neutral' && styles.successBannerNeutral,
            ]}
          >
            {session.banner.text}
          </Text>
        )}

        {/* Exactly one of these two is ever rendered (session.
            showGiveUpButton/showSkipDrillButton are mutually exclusive) --
            Playing Practice's own per-attempt give-up vs. Drilling's
            whole-drill skip (Phase 7). See PlayingPracticeController's doc
            comment for why these are two distinct controls. */}
        {session.showGiveUpButton && (
          <PillButton label="Having trouble? Skip this note" onPress={onGiveUp} />
        )}
        {session.showSkipDrillButton && (
          <PillButton label="Skip this drill" onPress={onSkipDrill} />
        )}
      </View>
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

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Deliberately duplicated from FingerTunerScreen.tsx's own (unexported)
 * `PillButton`, rather than extracting a shared component -- this phase's
 * scope is "add the new mode... don't touch the existing Finger Tuner
 * screen/logic," and this repo's own established convention for
 * small/simple UI helpers is local duplication over cross-file coupling
 * (see playing-practice-controller.ts's `formatSignedCents` comment for the
 * same precedent, sourced from apps/desktop/src/playing-practice-ui.ts).
 */
function PillButton({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.pillButton,
        primary && styles.pillButtonPrimary,
        disabled && styles.pillButtonDisabled,
      ]}
    >
      <Text style={[styles.pillButtonLabel, primary && styles.pillButtonLabelPrimary]}>
        {label}
      </Text>
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
  captureNotice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  captureNoticeText: {
    fontSize: 13,
    color: '#555',
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
  segmented: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  segment: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ddd',
    backgroundColor: '#f7f7f7',
  },
  segmentActive: {
    backgroundColor: '#eaf3ff',
    borderColor: '#8fbcf5',
  },
  segmentLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#666',
  },
  segmentLabelActive: {
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
  session: {
    gap: 4,
  },
  progress: {
    textAlign: 'center',
    fontSize: 12,
    color: '#666',
  },
  target: {
    alignItems: 'center',
    paddingVertical: 14,
    gap: 6,
  },
  modeLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#8a5b00',
  },
  targetNote: {
    fontSize: 56,
    fontWeight: '700',
    color: '#1a1a1a',
    fontVariant: ['tabular-nums'],
  },
  liveFeedback: {
    fontFamily: 'Menlo, monospace',
    fontSize: 14,
    color: '#666',
    minHeight: 18,
  },
  dwellTrack: {
    height: 6,
    width: '70%',
    maxWidth: 220,
    marginTop: 8,
    borderRadius: 999,
    backgroundColor: '#e9e9e9',
    overflow: 'hidden',
  },
  dwellFill: {
    height: '100%',
    backgroundColor: '#1a7f37',
  },
  successBanner: {
    marginTop: 8,
    fontSize: 20,
    fontWeight: '700',
    color: '#1a7f37',
  },
  // Drilling's "Moving on" (max-attempts-reached) reuses successBanner
  // itself (see PlayingPracticeController's showDrillEndBanner()) but reads
  // as neutral, not a win -- capping isn't a failure to punish. Matches
  // this file's own existing active-chip/segment/mode-tab blue (#1a4d8f)
  // rather than inventing a new hue, mirroring
  // apps/desktop/src/index.css's identical `.pp-banner-neutral` choice.
  successBannerNeutral: {
    color: '#1a4d8f',
  },

  // --- Complete screen ---------------------------------------------------
  completeBlock: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 16,
  },
  completeMessage: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a7f37',
  },

  // --- Shared button --------------------------------------------------
  pillButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignSelf: 'center',
    marginTop: 10,
  },
  pillButtonPrimary: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  pillButtonDisabled: {
    opacity: 0.5,
  },
  pillButtonLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
  },
  pillButtonLabelPrimary: {
    color: '#fff',
  },
});
