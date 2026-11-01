/**
 * Scoring: cents-tolerance bands, confidence/plausibility gating, and
 * dwell-time-to-count-as-"played" logic. Shared by Finger Tuner (gating +
 * tolerance only, no dwell) and Playing Practice / Drilling (gating +
 * tolerance + dwell, against a specific target note).
 *
 * All thresholds here are defaults to validate empirically in a later
 * phase, per the plan — not hardcoded folklore. See each constant's doc
 * comment for the specific reasoning and, where relevant, the Phase 1
 * numbers (packages/dsp-native/RESULTS.md) it was chosen against.
 */

/**
 * How far off pitch (in cents) a note can be while still counting as
 * "in tune".
 *
 * Chosen default: 25 cents. Reasoning:
 * - Professional-tuner precision is ~1-2 cents; ~5 cents is cited as the
 *   threshold an average listener can reliably perceive at all (see the
 *   plan's research). This is a *learning* tool, not a professional tuner —
 *   demanding imperceptibly-tight precision from a beginner would be
 *   discouraging and doesn't match the product's purpose, so this default
 *   is deliberately looser than either of those numbers, not an attempt to
 *   match them.
 * - It must also be loose enough to not be spuriously triggered by the
 *   pitch detector's own real-signal jitter, or a genuinely in-tune note
 *   reads as "out of tune" and the tool feels broken. Phase 1's empirical
 *   YIN numbers on real acoustic violin recordings (packages/dsp-native/RESULTS.md)
 *   found within-note pitch stability of 3.3-4.2 cents std-dev on the D/A/E
 *   strings but 33-72 cents on the (harder-to-track) G string. 25 cents
 *   comfortably clears the easy strings with margin; it will *not* fully
 *   absorb the G string's worst-case jitter — that's a known, documented
 *   tension rather than something papered over by this one constant (a
 *   later phase could use a wider tolerance specifically for the G string,
 *   or improve low-string tracking, if this proves annoying in practice).
 *
 * This is a tunable, not a locked constant — override via
 * `ScoringConfig.inTuneCentsTolerance`.
 */
export const DEFAULT_IN_TUNE_CENTS_TOLERANCE = 25;

/**
 * Minimum `PitchReading.confidence` (0..1) required to trust a voiced
 * reading at all; anything below this is treated as "unclear" rather than a
 * note, regardless of frequency.
 *
 * Chosen default: 0.5. Reasoning: packages/dsp-native's chosen primary
 * detector (YIN) already internally gates `voiced` on its own threshold
 * (CMNDF <= 0.15, i.e. confidence = 1-CMNDF >= ~0.85) before ever reporting
 * `voiced: true` — see packages/dsp-native/CLAUDE.md's "Numbers" section —
 * so in the common case this package's own gate at 0.5 is a permissive
 * extra safety margin sitting well below YIN's own floor, not the primary
 * defense (the `voiced` flag and the plausible-frequency-range gate below
 * are). It exists because packages/core is deliberately decoupled from
 * dsp-native (no dependency — see this package's CLAUDE.md) and may in
 * principle receive readings from a different or future source whose
 * confidence semantics are weaker than YIN's; 0.5 is a reasonable generic
 * "trust this at least this much" bar for that case. Tune this against
 * whatever detector is actually wired in once that wiring exists (Phase 3+).
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Plausible fundamental-frequency range for a violin note. Matches
 * packages/dsp-native's `PitchDetectorConfig::ForViolin` search range
 * exactly (150-1600Hz, covering G3~196Hz to ~D6~1175Hz with margin) — see
 * that package's CLAUDE.md "Numbers" section — so this package never treats
 * as plausible a frequency Phase 1 didn't validate the detector against.
 * A voiced reading outside this range is treated as "unclear", not a wrong
 * confident note (double-stops / non-violin noise edge case).
 */
export const DEFAULT_MIN_FREQUENCY_HZ = 150;
export const DEFAULT_MAX_FREQUENCY_HZ = 3000;

/**
 * Minimum time (ms) a pitch must stay continuously within the in-tune
 * tolerance band, on the current target note, before that note counts as
 * "played" for Playing Practice / Drilling scoring purposes.
 *
 * Chosen default: 150ms. Reasoning: this exists to guard against bow-attack
 * transients and fast slides/passing-tones registering as a deliberately
 * played note (see the plan's edge cases). packages/dsp-native's own
 * `OnsetSegmenter` already requires ~3 hops (~35ms at the validated
 * 512-sample/44.1kHz hop) of pitch stability before it will even confirm a
 * note *onset* at all (see packages/dsp-native/CLAUDE.md) — this package's
 * dwell time is a separate, longer-timescale, additive gate layered on top
 * of (not a replacement for) that: it answers "has the target note been
 * *held*, in tune, long enough to count as a deliberate attempt", not
 * "has a note started". 150ms is comfortably longer than a fast slide or a
 * single bow-bounce transient, while still much shorter than any
 * deliberately-held practice note (e.g. a quarter note at 100bpm is 600ms) —
 * chosen to feel responsive rather than laggy. Tunable, not locked.
 */
export const DEFAULT_MIN_DWELL_TIME_MS = 150;

/** A single pitch-detector reading, as this package understands it (shape matches dsp-native's `PitchResult`, independently defined — see this package's CLAUDE.md). */
export interface PitchReading {
  /** false => no confident periodic pitch found this frame; frequencyHz/confidence should be ignored. */
  readonly voiced: boolean;
  readonly frequencyHz: number;
  /** 0..1, higher = more confident. Meaning is detector-specific; see DEFAULT_MIN_CONFIDENCE's doc comment. */
  readonly confidence: number;
}

export interface ScoringConfig {
  readonly a4Hz?: number;
  readonly inTuneCentsTolerance?: number;
  readonly minConfidence?: number;
  readonly minFrequencyHz?: number;
  readonly maxFrequencyHz?: number;
}

export type GateResult =
  { readonly ok: true; readonly frequencyHz: number } | { readonly ok: false };

/**
 * Confidence + plausible-range gate shared by Finger Tuner and target-note
 * scoring. Never "guesses" a note: an unvoiced reading, a low-confidence
 * reading, or an implausible frequency are all rejected the same way
 * (`{ ok: false }`) — callers decide separately whether to surface that as
 * "no signal" (unvoiced) vs "unclear" (voiced but untrustworthy); see
 * ../tuner/finger-tuner.ts for that distinction.
 */
export function gateReading(reading: PitchReading, config: ScoringConfig = {}): GateResult {
  if (!reading.voiced) {
    return { ok: false };
  }
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minFrequencyHz = config.minFrequencyHz ?? DEFAULT_MIN_FREQUENCY_HZ;
  const maxFrequencyHz = config.maxFrequencyHz ?? DEFAULT_MAX_FREQUENCY_HZ;
  if (reading.confidence < minConfidence) {
    return { ok: false };
  }
  if (!(reading.frequencyHz >= minFrequencyHz) || !(reading.frequencyHz <= maxFrequencyHz)) {
    return { ok: false };
  }
  return { ok: true, frequencyHz: reading.frequencyHz };
}

/**
 * Cents offset of a (already-gated) frequency from a *specific* target
 * frequency — distinct from note.ts's `centsOffNearestNote`, which finds
 * the nearest note in general. This is what Playing Practice / Drilling use
 * (how far off is the user from the note they were asked to play), not
 * "what note is this".
 */
export function centsOffTarget(frequencyHz: number, targetFrequencyHz: number): number {
  return 1200 * Math.log2(frequencyHz / targetFrequencyHz);
}

export function isWithinTolerance(cents: number, config: ScoringConfig = {}): boolean {
  const tolerance = config.inTuneCentsTolerance ?? DEFAULT_IN_TUNE_CENTS_TOLERANCE;
  return Math.abs(cents) <= tolerance;
}

export interface DwellTrackerConfig extends ScoringConfig {
  readonly minDwellTimeMs?: number;
}

/**
 * Tracks whether a specific target note has been held continuously in tune
 * for long enough to count as "played". Stateful and stream-oriented: call
 * `update` once per timestamped reading, in order. Not thread-safe (mirrors
 * packages/dsp-native's OnsetSegmenter convention of one instance per
 * stream).
 *
 * Semantics (deliberately strict/continuous, not cumulative-with-gaps): any
 * reading that gates out (no-signal/unclear) or falls outside the in-tune
 * tolerance resets the held-duration counter to zero — this matches the
 * plan's framing of dwell time as "arrived and held", distinct from a
 * forgiving running average. Once satisfied, `isSatisfied` stays true (a
 * sticky latch) even if the reading later drops out — releasing the bow at
 * the end of a successfully-held note should not retroactively un-succeed
 * it. Call `reset()` to reuse an instance for a new target note.
 */
export class TargetNoteDwellTracker {
  private readonly targetFrequencyHz: number;
  private readonly config: DwellTrackerConfig;
  private holdStartMs: number | undefined;
  private lastTimestampMs: number | undefined;
  private satisfied = false;

  constructor(targetFrequencyHz: number, config: DwellTrackerConfig = {}) {
    if (!(targetFrequencyHz > 0)) {
      throw new RangeError(
        `TargetNoteDwellTracker: targetFrequencyHz must be > 0, got ${targetFrequencyHz}`,
      );
    }
    this.targetFrequencyHz = targetFrequencyHz;
    this.config = config;
  }

  /**
   * Feed one timestamped reading (`timestampMs` must be non-decreasing
   * across calls on one instance). Returns true exactly once: the instant
   * the dwell threshold is crossed. Returns false on every other call,
   * including subsequent calls after success (check `isSatisfied` instead
   * of relying on the return value to poll current status).
   */
  update(reading: PitchReading, timestampMs: number): boolean {
    if (this.lastTimestampMs !== undefined && timestampMs < this.lastTimestampMs) {
      throw new RangeError(
        `TargetNoteDwellTracker.update: timestampMs must be non-decreasing (got ${timestampMs} after ${this.lastTimestampMs})`,
      );
    }
    this.lastTimestampMs = timestampMs;

    if (this.satisfied) {
      return false;
    }

    const gated = gateReading(reading, this.config);
    const inTune =
      gated.ok &&
      isWithinTolerance(centsOffTarget(gated.frequencyHz, this.targetFrequencyHz), this.config);

    if (!inTune) {
      this.holdStartMs = undefined;
      return false;
    }

    if (this.holdStartMs === undefined) {
      this.holdStartMs = timestampMs;
    }

    const heldMs = timestampMs - this.holdStartMs;
    const minDwellTimeMs = this.config.minDwellTimeMs ?? DEFAULT_MIN_DWELL_TIME_MS;
    if (heldMs >= minDwellTimeMs) {
      this.satisfied = true;
      return true;
    }
    return false;
  }

  get isSatisfied(): boolean {
    return this.satisfied;
  }

  /** Milliseconds the target has been continuously held in tune so far (0 if not currently holding). */
  get currentHeldMs(): number {
    if (this.holdStartMs === undefined || this.lastTimestampMs === undefined) {
      return 0;
    }
    return this.lastTimestampMs - this.holdStartMs;
  }

  reset(): void {
    this.holdStartMs = undefined;
    this.lastTimestampMs = undefined;
    this.satisfied = false;
  }
}
