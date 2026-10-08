import { Text, View, Pressable, StyleSheet } from 'react-native';
import type { PlayingPracticeSessionViewState } from './practice-session-runner';

/**
 * Presentational pieces shared by the Playing Practice screen
 * (`./PlayingPracticeScreen.tsx`) and the ABC Notation screen
 * (`./AbcPracticeScreen.tsx`): the active-session panel (progress, target
 * note, optional "Next:" preview, live feedback, dwell bar, banner,
 * give-up/skip-drill button), the complete screen, and the small button /
 * segmented-control primitives both use. Extracted from
 * `PlayingPracticeScreen.tsx` unchanged (apart from the optional `Next:`
 * line) when ABC practice was added, so both modes read as the same product
 * and neither duplicates the other's UI. Purely presentational, no state.
 *
 * Color palette matches apps/desktop/src/index.css's "Playing Practice
 * (Phase 6)"/"Drilling UI (Phase 7)" sections exactly (#1a7f37 success
 * green, #8a5b00 drilling amber, #1a1a1a target-note dark, #666 secondary
 * text, #1a4d8f neutral "Moving on" blue -- reusing this app's existing
 * active-chip/segment/mode-tab blue rather than inventing a new hue, same as
 * desktop's own comment on that color choice).
 */

export function PillButton({
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
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
    >
      <Text style={[styles.pillButtonLabel, primary && styles.pillButtonLabelPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SegmentedControl<T extends string | number>({
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
            key={String(option.value)}
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
 * The "capture paused / disconnected" notice (Phase 8) both practice tabs
 * show, so a paused or lost input is never hidden behind the Finger Tuner tab.
 */
export function CaptureNotice({
  notice,
  onAction,
}: {
  notice: { readonly message: string; readonly actionLabel: string | undefined };
  onAction: () => void;
}) {
  return (
    <View style={styles.captureNotice}>
      <Text style={styles.captureNoticeText}>{notice.message}</Text>
      {notice.actionLabel && <PillButton label={notice.actionLabel} onPress={onAction} primary />}
    </View>
  );
}

/** The "...complete!" screen both modes end on. */
export function CompleteBlock({
  message,
  buttonLabel,
  onPress,
}: {
  message: string;
  buttonLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.completeBlock}>
      <Text style={styles.completeMessage}>{message}</Text>
      <PillButton label={buttonLabel} onPress={onPress} primary />
    </View>
  );
}

export function SessionPanel({
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

        {/* Only ever present for ABC practice (see PracticeSessionRunner's
            `showUpcoming`): a preview of the next few notes of the piece. */}
        {session.upcomingText !== undefined && session.upcomingText.length > 0 && (
          <Text style={styles.upcoming}>{session.upcomingText}</Text>
        )}

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

const styles = StyleSheet.create({
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
  upcoming: {
    fontFamily: 'Menlo, monospace',
    fontSize: 13,
    color: '#999',
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
  successBannerNeutral: {
    color: '#1a4d8f',
  },
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
