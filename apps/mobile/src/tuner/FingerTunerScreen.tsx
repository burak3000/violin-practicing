import { useCallback, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioInput, type AudioDeviceInfo } from 'react-native-audio-api';
import type { FingerTunerReading, SmoothedTunerReading } from '@violin/core';
import { CAN_RE_PROMPT_AFTER_DENIAL, type PermissionStatus } from '../audio/permissions';
import type { CaptureState } from '../audio/mic-capture-controller';
import { describeInputSelectError } from './input-select-error';
import { TunerMeter } from './TunerMeter';
import {
  formatCents,
  formatForDebug,
  formatFrequencyHz,
  toneFor,
  TUNER_STATE_LABEL_COLOR,
  TUNER_TONE_COLOR,
} from './tuner-view-model';

/**
 * Phase 5 Part B: the real mobile Finger Tuner screen, replacing the Phase
 * 4 debug UI. Mirrors apps/desktop's Phase 5 Part A design in substance
 * (see apps/desktop/CLAUDE.md's "Finger Tuner UI (Phase 5)" section): a
 * continuous note/cents/meter display with explicit, never-guessing
 * no-signal/unclear/reading states, a collapsed-by-default debug panel
 * underneath, and the same permission/device/start-stop controls Phase 4
 * already built -- now framed as an actual tuner screen rather than a
 * numbered debug-section list. The actual React Native components
 * necessarily differ from desktop's DOM/CSS (View-based meter instead of
 * a CSS gauge, Pressable device rows instead of a <select>, etc.) but the
 * underlying concepts and color language are the same.
 *
 * This component is deliberately presentational apart from the two pieces
 * of UI-local state that only this screen cares about (the debug panel's
 * collapsed/expanded flag, and the audio-input-picker's own error message)
 * -- everything about the actual capture session (permission requests,
 * starting/stopping capture, and the live reading stream) is owned by
 * App.tsx and passed in as props, so this file never touches
 * mic-capture-controller.ts or permissions.ts's own logic, only reads a
 * couple of their exported constants/types for display purposes.
 */

export interface FingerTunerScreenProps {
  readonly permission: PermissionStatus;
  readonly permissionBusy: boolean;
  readonly onRequestPermission: () => void;
  readonly onOpenSettings: () => void;

  readonly captureState: CaptureState;
  readonly onStart: () => void;
  readonly onStop: () => void;

  /** Shown only in the debug panel, side by side with `smoothedReading` -- see apps/desktop/CLAUDE.md's "Smoothing integration" section for why both are kept visible for troubleshooting. */
  readonly rawReading: FingerTunerReading;
  /** Drives the primary tuner display -- never the raw per-hop reading (see module doc comment). */
  readonly smoothedReading: SmoothedTunerReading;
  readonly onsetState: string;
  readonly clipping: boolean;

  readonly framesAnalyzed: number;
  readonly computeMsLast: number | undefined;
  readonly computeMsMean: number | undefined;
}

function fmtMs(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(2)}ms`;
}

export function FingerTunerScreen({
  permission,
  permissionBusy,
  onRequestPermission,
  onOpenSettings,
  captureState,
  onStart,
  onStop,
  rawReading,
  smoothedReading,
  onsetState,
  clipping,
  framesAnalyzed,
  computeMsLast,
  computeMsMean,
}: FingerTunerScreenProps) {
  const [debugVisible, setDebugVisible] = useState(false);

  // First-party device enumeration/selection hook (see
  // node_modules/react-native-audio-api's hooks/useAudioInput.ts). Its own
  // doc comment: explicit *selection* (`onSelectInput`) is "(iOS only
  // currently)" -- Android gets read-only `availableInputs` enumeration
  // and OS-automatic routing only, as of react-native-audio-api 0.13.3 --
  // see apps/mobile/CLAUDE.md's "External audio interface" section.
  const { availableInputs, currentInput, onSelectInput } = useAudioInput();
  const [inputSelectError, setInputSelectError] = useState<string | undefined>(undefined);

  const onPickInput = useCallback(
    (device: AudioDeviceInfo) => {
      setInputSelectError(undefined);
      onSelectInput(device).catch((err: unknown) => {
        setInputSelectError(describeInputSelectError(err, Platform.OS === 'android'));
      });
    },
    [onSelectInput],
  );

  const granted = permission === 'Granted';
  const running = captureState.status === 'running' || captureState.status === 'starting';
  const pausedWaitingForResume = captureState.status === 'paused';
  const canResume = captureState.status === 'paused' && captureState.resumeMode === 'manual';
  const tone = toneFor(smoothedReading);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Finger Tuner</Text>
        <Pressable
          onPress={() => setDebugVisible((v) => !v)}
          style={[styles.debugToggle, debugVisible && styles.debugToggleActive]}
          accessibilityRole="button"
          accessibilityState={{ expanded: debugVisible }}
        >
          <Text style={[styles.debugToggleLabel, debugVisible && styles.debugToggleLabelActive]}>
            {debugVisible ? 'Hide debug info' : 'Debug info'}
          </Text>
        </Pressable>
      </View>

      {!granted ? (
        <View style={styles.card}>
          <Text style={styles.cardHint}>
            Violin Practice needs microphone access (or a connected audio interface) to detect the
            pitch you&apos;re playing.
          </Text>
          {(permission === 'Undetermined' || CAN_RE_PROMPT_AFTER_DENIAL) && (
            <PillButton
              label={permissionBusy ? 'Requesting…' : 'Request microphone access'}
              onPress={onRequestPermission}
              disabled={permissionBusy}
            />
          )}
          {permission === 'Denied' && (
            <>
              <Text style={styles.warnText}>
                {Platform.OS === 'ios'
                  ? 'iOS only shows the permission prompt once. Grant access in Settings, then come back here.'
                  : 'Microphone access was denied. You can try again, or grant it in Settings.'}
              </Text>
              <PillButton label="Open Settings" onPress={onOpenSettings} />
            </>
          )}
        </View>
      ) : (
        <View style={styles.controlBar}>
          <View style={styles.deviceSection}>
            <Text style={styles.deviceSectionLabel}>Input</Text>
            {availableInputs.length === 0 ? (
              <Text style={styles.hint}>No input devices reported yet.</Text>
            ) : (
              availableInputs.map((device) => {
                const isCurrent = currentInput?.id === device.id;
                return (
                  <Pressable
                    key={device.id}
                    onPress={() => onPickInput(device)}
                    style={styles.deviceRow}
                  >
                    <Text style={[styles.deviceRowText, isCurrent && styles.deviceRowTextActive]}>
                      {isCurrent ? '● ' : '○ '}
                      {device.name}
                    </Text>
                  </Pressable>
                );
              })
            )}
            {inputSelectError && <Text style={styles.warnText}>{inputSelectError}</Text>}
          </View>
          <View style={styles.captureButtons}>
            <PillButton
              label={canResume ? 'Resume' : 'Start'}
              onPress={onStart}
              disabled={running || (pausedWaitingForResume && !canResume)}
              primary
            />
            <PillButton
              label="Stop"
              onPress={onStop}
              disabled={
                captureState.status !== 'running' &&
                captureState.status !== 'starting' &&
                captureState.status !== 'paused'
              }
            />
          </View>
          <Text style={styles.statusLine}>
            {captureState.status === 'error'
              ? `error: ${captureState.message}`
              : captureState.status === 'paused'
                ? `paused: ${captureState.message}`
                : captureState.status}
          </Text>
        </View>
      )}

      <View style={styles.tuner}>
        {(tone === 'no-signal' || tone === 'unclear') && (
          <Text style={[styles.stateLabel, { color: TUNER_STATE_LABEL_COLOR[tone] }]}>
            {tone === 'no-signal'
              ? 'No signal'
              : 'Unclear signal (bow noise, double-stop, or background noise?)'}
          </Text>
        )}

        <View style={styles.noteRow}>
          <Text style={[styles.noteText, { color: TUNER_TONE_COLOR[tone] }]}>
            {smoothedReading.status === 'reading' ? smoothedReading.note.label : '—'}
          </Text>
          {smoothedReading.status === 'reading' && (
            <Text style={[styles.centsText, { color: TUNER_TONE_COLOR[tone] }]}>
              {formatCents(smoothedReading.cents)}
            </Text>
          )}
        </View>

        <TunerMeter
          tone={tone}
          cents={smoothedReading.status === 'reading' ? smoothedReading.cents : undefined}
        />

        {smoothedReading.status === 'reading' && (
          <Text style={styles.frequency}>{formatFrequencyHz(smoothedReading.frequencyHz)}</Text>
        )}

        {clipping && <Text style={styles.clipWarning}>Clipping — reduce input gain</Text>}
      </View>

      {debugVisible && (
        <View style={styles.debugPanel}>
          <Text style={styles.debugTitle}>Debug info</Text>
          <Text style={styles.hint}>
            Not the tuner itself -- raw pipeline telemetry for troubleshooting. See
            apps/mobile/CLAUDE.md for what each number does and doesn&apos;t prove.
          </Text>
          <DebugRow label="Raw reading (unsmoothed, per-hop)" value={formatForDebug(rawReading)} />
          <DebugRow
            label="Smoothed reading (what the tuner above shows)"
            value={formatForDebug(smoothedReading)}
          />
          <DebugRow label="Onset state" value={onsetState} />
          <DebugRow label="Clipping" value={clipping ? 'YES — reduce input gain' : 'no'} />
          <DebugRow
            label="Hop compute time (last / mean)"
            value={`${fmtMs(computeMsLast)} / ${fmtMs(computeMsMean)}`}
          />
          <DebugRow label="Frames analyzed" value={String(framesAnalyzed)} />
          <Text style={styles.hint}>
            Hop budget is ~11.6ms (matches packages/dsp-ts&apos;s validated ANALYSIS_HOP_SIZE @
            44.1kHz) -- compute time should sit far below that, same bar Phase 1/3 held
            C++/desktop-TS to.
          </Text>
        </View>
      )}
    </View>
  );
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.debugRow}>
      <Text style={styles.debugRowLabel}>{label}</Text>
      <Text style={styles.debugRowValue}>{value}</Text>
    </View>
  );
}

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
  debugToggle: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  debugToggleActive: {
    borderColor: '#999',
    backgroundColor: '#f0f0f0',
  },
  debugToggleLabel: {
    fontSize: 12,
    color: '#666',
  },
  debugToggleLabelActive: {
    color: '#1a1a1a',
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  cardHint: {
    fontSize: 13,
    color: '#555',
  },
  controlBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
    paddingBottom: 10,
    gap: 8,
  },
  deviceSection: {
    gap: 2,
  },
  deviceSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#999',
  },
  deviceRow: {
    paddingVertical: 4,
  },
  deviceRowText: {
    fontSize: 13,
    color: '#555',
  },
  deviceRowTextActive: {
    color: '#1a1a1a',
    fontWeight: '600',
  },
  captureButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  statusLine: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: '#666',
  },
  pillButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
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
  tuner: {
    alignItems: 'center',
    paddingVertical: 14,
    gap: 4,
  },
  stateLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    textAlign: 'center',
    minHeight: 32,
    // `tuner`'s `alignItems: 'center'` would otherwise shrink this Text's
    // box to its own content width, which still wraps correctly in
    // practice but can look oddly narrow for the longer 'unclear' copy --
    // stretching it to the full available width first makes the centered
    // wrapping look right regardless.
    alignSelf: 'stretch',
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 10,
    minHeight: 72,
  },
  noteText: {
    fontSize: 64,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  centsText: {
    fontSize: 22,
    fontWeight: '600',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    minWidth: 60,
  },
  frequency: {
    marginTop: 10,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    color: '#999',
  },
  clipWarning: {
    marginTop: 6,
    fontSize: 13,
    fontWeight: '600',
    color: '#b91c1c',
  },
  warnText: {
    fontSize: 13,
    color: '#b45309',
  },
  hint: {
    fontSize: 11,
    color: '#888',
  },
  debugPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
    paddingTop: 10,
    gap: 8,
  },
  debugTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  debugRow: {
    gap: 1,
  },
  debugRowLabel: {
    fontSize: 11,
    color: '#888',
  },
  debugRowValue: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    color: '#222',
  },
});
