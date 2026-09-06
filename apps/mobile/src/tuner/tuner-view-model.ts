/**
 * Pure view-model derivation for the mobile Finger Tuner screen (Phase 5
 * Part B).
 *
 * Mirrors apps/desktop/src/renderer.ts's own `toneFor`/`formatCents`/
 * `formatForDebug`/meter-needle-position helpers in substance -- same
 * tri-state-plus-two-shades tone model (no-signal / unclear / in-tune /
 * close / out), same cents formatting, same "close vs. out" cosmetic
 * boundary -- reimplemented here as plain, React-Native-import-free
 * functions (no 'react-native', no JSX) so they are:
 *
 *   1. portable to both TunerMeter.tsx and FingerTunerScreen.tsx, and
 *   2. independently unit-testable, per this phase's own verification
 *      requirement that any new display-derivation logic gets real tests,
 *      not just "the component renders" -- see tuner-view-model.test.ts.
 *
 * None of this re-derives anything `packages/core` already decides
 * (tolerance, confidence gating, vibrato smoothing) -- it only decides how
 * to *label and color* whatever `@violin/core`'s `analyzeTunerReading` /
 * `TunerDisplaySmoother` already computed. Do not fork/reimplement any of
 * that math here; import it.
 */
import {
  DEFAULT_IN_TUNE_CENTS_TOLERANCE,
  type FingerTunerReading,
  type SmoothedTunerReading,
} from '@violin/core';

export type TunerTone = 'no-signal' | 'unclear' | 'in-tune' | 'close' | 'out';

/**
 * Halfway between the in-tune tolerance and the meter's +/-50c outer edge
 * -- a purely cosmetic threshold for the meter's 3-color in-tune/close/out
 * gradient, identical in purpose and value to
 * apps/desktop/src/renderer.ts's own `CLOSE_OUT_BOUNDARY_CENTS`. Does not
 * feed back into anything `packages/core` scores -- it only changes which
 * color the note/cents text and meter needle render.
 */
export const CLOSE_OUT_BOUNDARY_CENTS =
  DEFAULT_IN_TUNE_CENTS_TOLERANCE + (50 - DEFAULT_IN_TUNE_CENTS_TOLERANCE) / 2;

/**
 * Which of the 5 presentation tones a smoothed reading should render as.
 * Never distinguishes *which* note is playing -- only these 5 buckets.
 */
export function toneFor(reading: SmoothedTunerReading): TunerTone {
  if (reading.status === 'no-signal') return 'no-signal';
  if (reading.status === 'unclear') return 'unclear';
  if (reading.inTune) return 'in-tune';
  return Math.abs(reading.cents) <= CLOSE_OUT_BOUNDARY_CENTS ? 'close' : 'out';
}

/**
 * Signed cents label, e.g. "+12c", "-4c", "+0c". Mirrors packages/core's
 * note.ts `describeFrequency` sign-handling exactly: the sign is derived
 * from the *rounded* value, not the raw one, so anything that rounds to
 * zero always prints "+0c", never "-0c".
 */
export function formatCents(cents: number): string {
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}c`;
}

/** e.g. "440.02Hz" -- the frequency readout shown only while status is 'reading'. */
export function formatFrequencyHz(frequencyHz: number): string {
  return `${frequencyHz.toFixed(2)}Hz`;
}

/**
 * Where the meter needle should sit, as a 0..100 percent-of-track-width
 * value (50 == dead center == in tune). Clamps to the meter's displayed
 * +/-50c range exactly like apps/desktop/src/renderer.ts's own needle
 * math -- a reading further off than that still pins the needle at the
 * track's edge rather than running off it.
 */
export function needlePercent(cents: number): number {
  const clamped = Math.max(-50, Math.min(50, cents));
  return 50 + clamped;
}

/**
 * The in-tune zone's left offset and width, both as percent-of-track,
 * derived from the actual configured tolerance rather than a hardcoded
 * matching number -- the same intent as apps/desktop/index.css's
 * `--in-tune-zone-half-width` custom property (which renderer.ts also
 * sets from this same packages/core constant, not a CSS literal).
 * `toleranceCents` defaults to packages/core's real
 * `DEFAULT_IN_TUNE_CENTS_TOLERANCE` so the drawn zone stays honest if that
 * default is ever retuned. Clamps to [0, 50] so a pathological override
 * can't produce a negative width or a zone wider than the track.
 */
export function inTuneZoneBounds(toleranceCents: number = DEFAULT_IN_TUNE_CENTS_TOLERANCE): {
  readonly leftPercent: number;
  readonly widthPercent: number;
} {
  const clampedTolerance = Math.max(0, Math.min(50, toleranceCents));
  return {
    leftPercent: 50 - clampedTolerance,
    widthPercent: clampedTolerance * 2,
  };
}

/**
 * `FingerTunerReading` and `SmoothedTunerReading` are deliberately the
 * same shape (see packages/core's tuner-display-smoother.ts doc comment)
 * -- one formatter covers both for the debug panel's raw-vs-smoothed
 * comparison, identical in output to apps/desktop/src/renderer.ts's own
 * `formatForDebug`.
 */
export function formatForDebug(reading: FingerTunerReading | SmoothedTunerReading): string {
  switch (reading.status) {
    case 'no-signal':
      return 'no signal';
    case 'unclear':
      return 'unclear';
    case 'reading':
      return `${reading.note.label} ${formatCents(reading.cents)} (${formatFrequencyHz(reading.frequencyHz)})${
        reading.inTune ? ' [in tune]' : ''
      }`;
  }
}

/**
 * Tone -> primary note/cents-text and meter-needle color. Values match
 * apps/desktop/index.css's tri-state palette exactly, so the two apps'
 * tuners read as the same product. A `Record<TunerTone, string>` so
 * TypeScript itself enforces every tone has a color if `TunerTone` ever
 * grows a new member -- no separate runtime test needed for exhaustiveness.
 *
 * Note that 'unclear' intentionally shares 'no-signal'\'s neutral gray here
 * (matching desktop: `.tuner-note`/`.tuner-cents` have no
 * `[data-tone='unclear']` override, only `.tuner-state-label` does -- see
 * `TUNER_STATE_LABEL_COLOR` below) -- an unclear reading never shows a note
 * anyway (see FingerTunerScreen.tsx), so this color is only actually used
 * via the meter needle, which is hidden (not rendered) for both of these
 * two tones regardless.
 */
export const TUNER_TONE_COLOR: Record<TunerTone, string> = {
  'no-signal': '#b8b8b8',
  unclear: '#b8b8b8',
  'in-tune': '#1a7f37',
  close: '#b45309',
  out: '#b91c1c',
};

/**
 * The uppercase state-label's own accent color for the two non-reading
 * tones (mirrors index.css's `.tuner-state-label` default color vs. its
 * `[data-tone='unclear']` override). 'in-tune'/'close'/'out' never show
 * the state label at all (see FingerTunerScreen.tsx), so they have no
 * entry here.
 */
export const TUNER_STATE_LABEL_COLOR: Record<'no-signal' | 'unclear', string> = {
  'no-signal': '#8a8a8a',
  unclear: '#b45309',
};
