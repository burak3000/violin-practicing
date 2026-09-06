/**
 * TypeScript mirror of packages/dsp-native's `include/dsp_native/types.h`
 * (`PitchDetectorConfig` / `PitchResult`). Kept field-for-field identical
 * to that C++ interface -- see this package's CLAUDE.md and
 * apps/desktop/CLAUDE.md's "DSP binding decision" section for why this
 * package exists as a TS port of the validated YIN algorithm instead of
 * binding the C++ directly on either platform.
 *
 * Deliberately does NOT include `mpmClarityThreshold`: this port only
 * implements YIN (packages/dsp-native's empirically-chosen primary
 * algorithm per its RESULTS.md), not MPM, per Phase 3's explicit scope
 * ("reuse the algorithm Phase 1 already validated (YIN...)"), unchanged by
 * this package's Phase 4 promotion out of apps/desktop.
 */

export interface PitchDetectorConfig {
  readonly sampleRateHz: number;

  // Search range for the fundamental period. Matches
  // packages/dsp-native's PitchDetectorConfig::ForViolin exactly (violin's
  // practical range G3~196Hz to ~D6~1175Hz, with margin) -- see that
  // package's CLAUDE.md "Numbers" section. Never drift this from
  // dsp-native's own defaults without updating both places.
  readonly minFrequencyHz: number;
  readonly maxFrequencyHz: number;

  // YIN: absolute threshold on the cumulative mean normalized difference
  // function. de Cheveigne & Kawahara (2002) recommend 0.10-0.15;
  // dsp-native validated 0.15 (see its CLAUDE.md/RESULTS.md) -- this port
  // uses that exact validated value as its default, not a re-derivation.
  readonly yinThreshold: number;
}

export const VIOLIN_MIN_FREQUENCY_HZ = 150;
export const VIOLIN_MAX_FREQUENCY_HZ = 1600;
export const DEFAULT_YIN_THRESHOLD = 0.15;

/** Mirrors `PitchDetectorConfig::ForViolin(sampleRateHz)` -- the validated violin-range defaults, parameterized only by sample rate. */
export function forViolin(sampleRateHz: number): PitchDetectorConfig {
  return {
    sampleRateHz,
    minFrequencyHz: VIOLIN_MIN_FREQUENCY_HZ,
    maxFrequencyHz: VIOLIN_MAX_FREQUENCY_HZ,
    yinThreshold: DEFAULT_YIN_THRESHOLD,
  };
}

/**
 * Mirrors `PitchDetectorConfig::MinRecommendedFrameSize()`: the smallest
 * analysis frame giving ~2 full periods of the lowest searched frequency.
 */
export function minRecommendedFrameSize(config: PitchDetectorConfig): number {
  const tauMax = Math.ceil(config.sampleRateHz / config.minFrequencyHz);
  return 3 * tauMax;
}

/** Mirrors `PitchResult` -- both YIN implementations (C++ and this TS port) fill in every field identically. */
export interface PitchResult {
  /** false => no confident periodic pitch found this frame; frequencyHz/confidence should be ignored. */
  readonly voiced: boolean;
  readonly frequencyHz: number;
  /** 0..1, higher = more confident. YIN reports 1 - CMNDF at the chosen lag (see yin-detector.ts). */
  readonly confidence: number;
  /** Sub-sample-interpolated lag; 0 if !voiced. */
  readonly periodSamples: number;
}

export const UNVOICED_PITCH_RESULT: PitchResult = Object.freeze({
  voiced: false,
  frequencyHz: 0,
  confidence: 0,
  periodSamples: 0,
});
