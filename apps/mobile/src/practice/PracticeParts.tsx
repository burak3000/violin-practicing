import { Text, View, Pressable, StyleSheet } from 'react-native';
import type { PlayingPracticeSessionViewState } from './practice-session-runner';
import { ScoreView } from './ScoreView';
import { StaffView } from './StaffView';

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

/** How the target note is shown: its letter name ("D4") or on a staff. One setting, shared by both practice screens (held in App.tsx). */
export type NoteDisplay = 'letters' | 'staff';

const NOTE_DISPLAY_OPTIONS: ReadonlyArray<{ value: NoteDisplay; label: string }> = [
  { value: 'letters', label: 'Letters' },
  { value: 'staff', label: 'Staff' },
];

/** "Drill missed notes: On | Off". Shared by both practice screens (held in App.tsx). */
export function DrillingToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.noteDisplayRow}>
      <Text style={styles.noteDisplayLabel}>Drill missed notes</Text>
      <SegmentedControl
        options={DRILLING_OPTIONS}
        value={value ? 'on' : 'off'}
        onChange={(choice) => onChange(choice === 'on')}
      />
    </View>
  );
}

const DRILLING_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** "Finger numbers: Show | Hide" (ABC practice; held in App.tsx). 0 is an open string; grey numbers are suggestions. */
export function FingersToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.noteDisplayRow}>
      <Text style={styles.noteDisplayLabel}>Finger numbers</Text>
      <SegmentedControl
        options={FINGER_OPTIONS}
        value={value ? 'show' : 'hide'}
        onChange={(choice) => onChange(choice === 'show')}
      />
    </View>
  );
}

const FINGER_OPTIONS = [
  { value: 'show', label: 'Show' },
  { value: 'hide', label: 'Hide' },
] as const;

/** "Show notes as: Letters | Staff". */
export function NoteDisplayToggle({
  value,
  onChange,
}: {
  value: NoteDisplay;
  onChange: (value: NoteDisplay) => void;
}) {
  return (
    <View style={styles.noteDisplayRow}>
      <Text style={styles.noteDisplayLabel}>Show notes as</Text>
      <SegmentedControl options={NOTE_DISPLAY_OPTIONS} value={value} onChange={onChange} />
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

/** The "...complete!" screen both modes end on. `secondary` is an optional extra button (ABC practice offers "Play along again" after practicing just the missed notes). */
export function CompleteBlock({
  message,
  buttonLabel,
  onPress,
  secondary,
}: {
  message: string;
  buttonLabel: string;
  onPress: () => void;
  secondary?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.completeBlock}>
      <Text style={styles.completeMessage}>{message}</Text>
      <PillButton label={buttonLabel} onPress={onPress} primary />
      {secondary && <PillButton label={secondary.label} onPress={secondary.onPress} />}
    </View>
  );
}

/** The live "Hearing A4 (+8c from target)" line, shared by the Wait-for-me session and the play-along panel. Reserves its height so the layout does not jump when text appears. */
export function LiveFeedbackLine({ text }: { text: string }) {
  return <Text style={styles.liveFeedback}>{text.length > 0 ? text : ' '}</Text>;
}

/** The dwell-progress bar (how far through the current in-tune hold), shared by the Wait-for-me session and the play-along panel. */
export function DwellBar({ fraction }: { fraction: number }) {
  return (
    <View style={styles.dwellTrack}>
      <View style={[styles.dwellFill, { width: `${Math.min(1, Math.max(0, fraction)) * 100}%` }]} />
    </View>
  );
}

export function SessionPanel({
  session,
  noteDisplay,
  onGiveUp,
  onSkipDrill,
}: {
  session: Extract<PlayingPracticeSessionViewState, { kind: 'active' }>;
  noteDisplay: NoteDisplay;
  onGiveUp: () => void;
  onSkipDrill: () => void;
}) {
  const showStaff = noteDisplay === 'staff';
  const isDrilling = session.mode === 'drilling';
  return (
    <View style={styles.session}>
      <Text style={styles.progress}>{session.progressText}</Text>

      <View style={styles.target}>
        {isDrilling && <Text style={styles.modeLabel}>Drilling</Text>}
        {showStaff ? (
          session.score ? (
            // An ABC session over the piece in order: the notated score,
            // starting at the target's bar, with the target note highlighted
            // (it follows Drilling's current target too).
            <ScoreView
              piece={session.score.piece}
              firstBar={session.score.piece.noteElements[session.score.targetIndex]?.bar ?? 0}
              targetIndex={session.score.targetIndex}
              fingers={session.score.fingers}
            />
          ) : (
            // On a staff the target (and, for ABC, the notes after it) are
            // drawn instead of the letter name and the "Next:" text line.
            // A runner with a "Next:" preview (ABC practice) also looks ahead on the staff.
            <StaffView notes={session.staffNotes} lookahead={session.upcomingText !== undefined} />
          )
        ) : (
          <>
            <Text style={styles.targetNote}>{session.targetNoteLabel}</Text>

            {/* Only ever present for ABC practice (see PracticeSessionRunner's
                `showUpcoming`): a preview of the next few notes of the piece. */}
            {session.upcomingText !== undefined && session.upcomingText.length > 0 && (
              <Text style={styles.upcoming}>{session.upcomingText}</Text>
            )}
          </>
        )}

        {/* Finger line: under the letter name, or under a staff that cannot carry the digits
            (the score window draws its own digits over the notes). */}
        {session.finger !== undefined && !(showStaff && session.score) && (
          <Text style={styles.finger}>{session.finger.text}</Text>
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
  noteDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noteDisplayLabel: {
    fontSize: 12,
    color: '#666',
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
  finger: {
    fontSize: 18,
    color: '#1a1a1a',
    textAlign: 'center',
    marginTop: 4,
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
