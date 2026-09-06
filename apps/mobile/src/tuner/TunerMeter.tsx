import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import {
  inTuneZoneBounds,
  needlePercent,
  TUNER_TONE_COLOR,
  type TunerTone,
} from './tuner-view-model';

/**
 * The Finger Tuner's horizontal +/-50-cent gauge -- the React Native
 * analogue of apps/desktop/index.css's `.tuner-meter` (a shaded in-tune
 * zone, a center tick, and a needle that moves continuously with the
 * smoothed cents value). There is no DOM/CSS here, so this ports the
 * *concept* (same geometry, same color logic, same hidden-during-
 * no-signal/unclear behavior) using RN `View`s positioned with percentage
 * `left`/`width`, not a literal translation of the CSS -- see
 * apps/desktop/CLAUDE.md's "Finger Tuner UI (Phase 5)" section for the
 * design this mirrors.
 *
 * All of the position/color *math* lives in ./tuner-view-model.ts (tested
 * there) -- this component only lays those numbers out and animates
 * between them.
 */

export interface TunerMeterProps {
  readonly tone: TunerTone;
  /** Cents to point the needle at; `undefined` parks the needle at dead center while it's hidden (no-signal/unclear -- mirrors apps/desktop/src/renderer.ts's `tunerMeterNeedle.style.left = '50%'` for those two states). */
  readonly cents: number | undefined;
  /** Half-width of the in-tune zone, in cents. Defaults to packages/core's real DEFAULT_IN_TUNE_CENTS_TOLERANCE inside inTuneZoneBounds() -- see that function's own doc comment. */
  readonly inTuneToleranceCents?: number;
}

const NEEDLE_MOVE_MS = 80; // matches index.css's `.tuner-meter-needle { transition: left 80ms linear }`
const NEEDLE_FADE_MS = 150; // matches index.css's `opacity 150ms ease`

const NEEDLE_VISIBLE_TONES: ReadonlySet<TunerTone> = new Set(['in-tune', 'close', 'out']);

export function TunerMeter({ tone, cents, inTuneToleranceCents }: TunerMeterProps) {
  const targetPercent = needlePercent(cents ?? 0);
  const needleLeft = useRef(new Animated.Value(targetPercent)).current;
  const needleOpacity = useRef(new Animated.Value(NEEDLE_VISIBLE_TONES.has(tone) ? 1 : 0)).current;

  // Note: this repo's eslint.config.mjs doesn't register `eslint-plugin-
  // react-hooks` (see that file's own top comment on why type-aware/plugin
  // lint wiring was deliberately kept minimal), so there's no
  // exhaustive-deps rule to satisfy or suppress here -- `needleLeft` /
  // `needleOpacity` are stable refs for this component's lifetime by
  // construction (see the `useRef` calls above), so omitting them from
  // each effect's dependency array is correct, not a lint workaround.
  useEffect(() => {
    Animated.timing(needleLeft, {
      toValue: targetPercent,
      duration: NEEDLE_MOVE_MS,
      useNativeDriver: false, // animating a percentage `left`, which the native driver can't handle
    }).start();
  }, [targetPercent, needleLeft]);

  useEffect(() => {
    Animated.timing(needleOpacity, {
      toValue: NEEDLE_VISIBLE_TONES.has(tone) ? 1 : 0,
      duration: NEEDLE_FADE_MS,
      useNativeDriver: false,
    }).start();
  }, [tone, needleOpacity]);

  const { leftPercent: zoneLeft, widthPercent: zoneWidth } = inTuneZoneBounds(inTuneToleranceCents);

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View style={[styles.inTuneZone, { left: `${zoneLeft}%`, width: `${zoneWidth}%` }]} />
        <View style={styles.centerTick} />
        <Animated.View
          style={[
            styles.needle,
            {
              left: needleLeft.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
              opacity: needleOpacity,
              backgroundColor: TUNER_TONE_COLOR[tone],
            },
          ]}
        />
      </View>
      <View style={styles.scaleRow}>
        <Text style={styles.scaleLabel}>flat</Text>
        <Text style={styles.scaleLabel}>in tune</Text>
        <Text style={styles.scaleLabel}>sharp</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Explicit full-width, rather than relying on default flex sizing: the
  // caller (FingerTunerScreen.tsx's `tuner` container) uses
  // `alignItems: 'center'` so its note/cents text shrinks to content width
  // and sits centered -- without an explicit width here, this component's
  // root View would inherit that same shrink-to-fit behavior and the
  // meter would render only as wide as its "flat"/"in tune"/"sharp"
  // labels, not as a real gauge spanning the available width.
  container: {
    width: '100%',
  },
  track: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#e9e9e9',
    position: 'relative',
    overflow: 'visible',
  },
  inTuneZone: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: '#cdeed6',
    borderRadius: 999,
  },
  centerTick: {
    position: 'absolute',
    left: '50%',
    top: -4,
    bottom: -4,
    width: 2,
    marginLeft: -1,
    backgroundColor: '#aaa',
  },
  needle: {
    position: 'absolute',
    top: -9,
    bottom: -9,
    width: 4,
    marginLeft: -2,
    borderRadius: 2,
    backgroundColor: '#b8b8b8',
  },
  scaleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 5,
  },
  scaleLabel: {
    fontSize: 11,
    color: '#aaa',
  },
});
