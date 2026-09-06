/**
 * Finger Tuner: stateless/continuous pitch feedback.
 *
 * Per the plan: given a stream of pitch readings, continuously reports the
 * current note + cents-off with no session concept (no target note, no
 * progression, no memory between readings) — distinct from Playing
 * Practice's dwell-gated "arrived and held" scoring, which needs a specific
 * target and holds state across readings. Finger Tuner should show a slide
 * (portamento/glissando) as it happens rather than debouncing it, per the
 * plan's edge cases, so this deliberately applies no dwell-time smoothing.
 *
 * "State machine" here means the small set of discrete *output* states
 * (`no-signal` / `unclear` / `reading`) derived fresh from each input, not
 * literal internal memory — `analyzeTunerReading` is a pure function; the
 * `FingerTuner` class is a thin, config-holding wrapper around it for API
 * symmetry with the other two (stateful) session machines.
 */

import { analyzeFrequency, DEFAULT_A4_HZ, type NoteName } from '../note/note.js';
import {
  gateReading,
  isWithinTolerance,
  type PitchReading,
  type ScoringConfig,
} from '../scoring/scoring.js';

export type FingerTunerReading =
  | { readonly status: 'no-signal' }
  | { readonly status: 'unclear' }
  | {
      readonly status: 'reading';
      readonly note: NoteName;
      readonly cents: number;
      readonly inTune: boolean;
      readonly frequencyHz: number;
    };

// No fields beyond ScoringConfig today; kept as a distinct alias (rather than
// reusing ScoringConfig directly at every call site) so Finger Tuner's config
// can grow independently later without touching scoring.ts's shape.
export type FingerTunerConfig = ScoringConfig;

/**
 * Pure function: one reading in, one tuner state out. `voiced: false` (or a
 * reading that fails the confidence/plausible-range gate) never guesses a
 * note — see ../scoring/scoring.ts's `gateReading` doc comment — it maps to
 * `no-signal` (nothing detected) or `unclear` (something detected but not
 * trustworthy enough to name, e.g. a double-stop or background noise)
 * respectively.
 */
export function analyzeTunerReading(
  reading: PitchReading,
  config: FingerTunerConfig = {},
): FingerTunerReading {
  if (!reading.voiced) {
    return { status: 'no-signal' };
  }
  const gated = gateReading(reading, config);
  if (!gated.ok) {
    return { status: 'unclear' };
  }
  const a4Hz = config.a4Hz ?? DEFAULT_A4_HZ;
  const { note, cents } = analyzeFrequency(gated.frequencyHz, a4Hz);
  return {
    status: 'reading',
    note,
    cents,
    inTune: isWithinTolerance(cents, config),
    frequencyHz: gated.frequencyHz,
  };
}

/** Thin stateless wrapper around `analyzeTunerReading` that just holds config — see module doc comment for why this isn't a "real" state machine. */
export class FingerTuner {
  constructor(private readonly config: FingerTunerConfig = {}) {}

  analyze(reading: PitchReading): FingerTunerReading {
    return analyzeTunerReading(reading, this.config);
  }
}
