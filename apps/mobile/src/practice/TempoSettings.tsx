import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { clampTempoBpm } from '@violin/core';
import {
  ABC_COUNT_IN_CHOICES,
  type AbcCountInBars,
  type AbcTempoViewState,
} from './abc-practice-controller';
import { PillButton, SegmentedControl } from './PracticeParts';

/**
 * The tempo and count-in settings of the ABC import screen (play-along style).
 *
 * The tempo is read from the file (or defaulted when it has none) and can be
 * changed here without touching the file: a number field plus -5/-1/+1/+5
 * steppers (no slider library is installed, and steppers are easier to hit
 * on a phone than a thumb drag anyway), the percentage of the written tempo
 * it amounts to, and a button back to the written tempo. All numbers and
 * wording come from `packages/core`'s `describeTempoSettings` (the same call
 * desktop's tempo control uses, so the two say identical things), handed over
 * by `AbcPracticeController` as `AbcTempoViewState.settings`; this file only
 * lays them out.
 *
 * The tempo field keeps its own text while it has focus so the controller
 * never fights a half-typed number: it is applied (rounded and clamped) when
 * editing ends. The keyboard is not "persisted across taps", so tapping
 * anywhere else first dismisses it and commits the number.
 */

const STEPS: ReadonlyArray<{ delta: number; label: string }> = [
  { delta: -5, label: '−5' },
  { delta: -1, label: '−1' },
];
const STEPS_UP: ReadonlyArray<{ delta: number; label: string }> = [
  { delta: 1, label: '+1' },
  { delta: 5, label: '+5' },
];

function StepButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.step, disabled && styles.stepDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`Tempo ${label} beats per minute`}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.stepLabel}>{label}</Text>
    </Pressable>
  );
}

function TempoField({
  tempo,
  onSetTempo,
}: {
  tempo: AbcTempoViewState;
  onSetTempo: (bpm: number) => void;
}) {
  const { bpm, unitSymbol } = tempo.settings;
  const [text, setText] = useState(String(bpm));
  // The tempo changed from outside the field (a stepper, reset, a new tune).
  useEffect(() => {
    setText(String(bpm));
  }, [bpm]);

  const commit = (): void => {
    const typed = Number(text.trim());
    if (!Number.isFinite(typed) || typed <= 0) {
      setText(String(bpm));
      return;
    }
    // Same clamp the controller applies (core's `clampTempoBpm`), so the text
    // shows what was actually set even when it equals the current tempo.
    const clamped = clampTempoBpm(typed);
    setText(String(clamped));
    onSetTempo(clamped);
  };

  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.beatSymbol}>{unitSymbol} =</Text>
      <TextInput
        style={styles.field}
        value={text}
        onChangeText={(t) => setText(t.replace(/[^0-9]/g, '').slice(0, 3))}
        onEndEditing={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        maxLength={3}
        selectTextOnFocus
        accessibilityLabel="Tempo in beats per minute"
      />
    </View>
  );
}

export function TempoSettings({
  tempo,
  countInBars,
  onSetTempo,
  onResetTempo,
  onSetCountIn,
}: {
  tempo: AbcTempoViewState;
  countInBars: AbcCountInBars;
  onSetTempo: (bpm: number) => void;
  onResetTempo: () => void;
  onSetCountIn: (bars: AbcCountInBars) => void;
}) {
  const { settings } = tempo;
  // `settings.hints` is the percentage ("92% of the written tempo") followed by
  // any assumptions the app made (no tempo marking / no time signature).
  const [percentText, ...assumptions] = settings.hints;
  return (
    <View style={styles.block}>
      <Text style={styles.fieldLabel}>Tempo</Text>
      <View style={styles.stepper}>
        {STEPS.map((s) => (
          <StepButton
            key={s.delta}
            label={s.label}
            disabled={settings.bpm <= tempo.minBpm}
            onPress={() => onSetTempo(settings.bpm + s.delta)}
          />
        ))}
        <TempoField tempo={tempo} onSetTempo={onSetTempo} />
        {STEPS_UP.map((s) => (
          <StepButton
            key={s.delta}
            label={s.label}
            disabled={settings.bpm >= tempo.maxBpm}
            onPress={() => onSetTempo(settings.bpm + s.delta)}
          />
        ))}
      </View>
      <Text style={styles.percent}>{percentText}</Text>
      {settings.differs && (
        <PillButton
          label={`Reset to ${tempo.source === 'file' ? 'written' : 'default'} tempo (${settings.writtenText})`}
          onPress={onResetTempo}
        />
      )}
      {assumptions.map((hint) => (
        <Text key={hint} style={styles.assumed}>
          {hint}
        </Text>
      ))}

      <Text style={[styles.fieldLabel, styles.spaced]}>Count-in</Text>
      <SegmentedControl
        options={ABC_COUNT_IN_CHOICES}
        value={countInBars}
        onChange={onSetCountIn}
      />
      <Text style={styles.note}>
        {tempo.countInBeats === 0
          ? 'No count-in: the music starts right after you press Start.'
          : `${tempo.countInBeats} ${tempo.countInBeats === 1 ? 'beat' : 'beats'} counted in before the first note.`}
      </Text>
      <Text style={styles.visualOnly}>
        Visual beat only on mobile for now — you will see the beat, not hear a click.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#999',
    marginTop: 4,
  },
  spaced: {
    marginTop: 8,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  step: {
    minWidth: 44,
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    backgroundColor: '#f7f7f7',
  },
  stepDisabled: {
    opacity: 0.4,
  },
  stepLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#333',
    fontVariant: ['tabular-nums'],
  },
  fieldWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 6,
    marginHorizontal: 4,
  },
  beatSymbol: {
    fontSize: 18,
    fontWeight: '600',
    color: '#444',
  },
  field: {
    // A fixed width (not minWidth): a text input otherwise stretches to fill
    // the row on some platforms and pushes the steppers off-screen.
    width: 72,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#8fbcf5',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#fff',
    fontVariant: ['tabular-nums'],
  },
  percent: {
    textAlign: 'center',
    fontSize: 12,
    color: '#666',
  },
  // Defaults the app assumed because the file did not say (no tempo, no time signature).
  assumed: {
    fontSize: 12,
    color: '#8a5b00',
  },
  note: {
    fontSize: 12,
    color: '#666',
  },
  visualOnly: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic',
  },
});
